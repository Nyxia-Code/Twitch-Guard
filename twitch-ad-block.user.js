// ==UserScript==
// @name         Twitch Ad Block — Quality Guard
// @namespace    local.twitch-quality-guard
// @version      1.1.6
// @description  Conservative HLS ad suppression with strict rendition checks and honest status.
// @match        https://www.twitch.tv/*
// @match        https://player.twitch.tv/*
// @run-at       document-start
// @inject-into  page
// @sandbox      raw
// @grant        none
// ==/UserScript==

(function () {
    'use strict';
    const DEBUG = false;
    const CONFIG = Object.freeze({ debug: DEBUG, timeout: 3500,
        cacheTTL: 60000, maxEntries: 512, retryDelay: 15000, maxAttempts: 3, statusTTL: 30000 });

    // Self-contained factory: exactly the same code runs in the page, workers and tests.
    // Observational only: never used to classify, select, or rewrite media.
    function readAdTiming(text, clock, unavailable = () => {}) {
        const missing = reason => { unavailable(reason); return null; };
        if (!clock || !Number.isFinite(clock.serverNow) || !Number.isFinite(clock.observedAt)) return missing('no-trustworthy-server-clock');
        const ranges = [];
        let markers = 0, plannedOnly = false;
        for (const line of text.split('\n')) {
            if (!line.startsWith('#EXT-X-DATERANGE:')) continue;
            const a = Object.fromEntries([...line.matchAll(/([A-Z0-9-]+)=("[^"]*"|[^,\r]*)/g)].map(m => [m[1], m[2].replace(/^"|"$/g, '')]));
            if (a.CLASS !== 'twitch-stitched-ad' && !/^stitched-ad(?:-|$)/.test(a.ID || '')) continue;
            markers++; if (!a.DURATION && !a['END-DATE'] && a['PLANNED-DURATION']) plannedOnly = true;
            const start = Date.parse(a['START-DATE']), explicitEnd = Date.parse(a['END-DATE']);
            const duration = a.DURATION === undefined ? NaN : Number(a.DURATION);
            const end = Number.isFinite(explicitEnd) ? explicitEnd : start + duration * 1000;
            if (!a.ID || !Number.isFinite(start) || !Number.isFinite(end) || end <= start || end - start > 600000 ||
                (Number.isFinite(explicitEnd) && Number.isFinite(duration) && Math.abs(end - start - duration * 1000) > 1)) continue;
            ranges.push({ start, end, count: Number(a['X-TV-TWITCH-AD-POD-LENGTH'] || 1),
                position: Number(a['X-TV-TWITCH-AD-POD-POSITION']), session: a['X-TV-TWITCH-AD-AD-SESSION-ID'] });
        }
        const active = ranges.filter(r => r.start <= clock.serverNow && clock.serverNow < r.end);
        if (active.length !== 1) return missing(!markers ? 'no-ad-date-range' : !ranges.length ?
            plannedOnly ? 'planned-duration-only' : 'missing-or-invalid-actual-duration' : active.length ? 'overlapping-ad-ranges' : 'outside-ad-time-range');
        let { start, end } = active[0];
        const ad = active[0]; let scope = 'individual';
        if (!Number.isInteger(ad.count) || ad.count < 1 || ad.count > 32) return missing('invalid-pod-metadata');
        if (ad.count > 1) {
            if (!ad.session) return missing('missing-pod-identity');
            const pod = ranges.filter(r => r.session === ad.session).sort((a, b) => a.position - b.position);
            if (pod.length !== ad.count || pod.some((r, i) => r.count !== ad.count || r.position !== i || (i && Math.abs(r.start - pod[i - 1].end) > 1))) return missing('incomplete-or-inconsistent-pod');
            start = pod[0].start; end = pod.at(-1).end; scope = 'pod';
        }
        return { start, end, scope, observedAt: clock.observedAt,
            deadline: clock.observedAt + end - clock.serverNow, clockSource: clock.source || 'http-date',
            basis: clock.source && clock.source !== 'http-date' ? 'hls-actual-range-server-time' : 'hls-actual-range-server-date' };
    }
    function createCountdown(now) {
        let timing = null, newest = -Infinity;
        const sources = new Map();
        return {
            report(data, source) {
                const t = data.timing;
                if (!t || !['hls-actual-range-server-date', 'hls-actual-range-server-time'].includes(t.basis) || !['pod', 'individual'].includes(t.scope) ||
                    ![t.start, t.end, t.deadline, t.observedAt].every(Number.isFinite) || t.end <= t.start ||
                    t.deadline - t.observedAt > 600000 || now() - t.observedAt >= 30000 || t.observedAt > now() + 1000) return;
                const previous = sources.get(source);
                if (previous && (data.generation < previous.generation || t.observedAt <= previous.at)) return;
                sources.set(source, { generation: data.generation, at: t.observedAt });
                if (sources.size > 128) sources.delete(sources.keys().next().value);
                if (t.observedAt < newest) return;
                newest = t.observedAt;
                // Same range cannot grow on repeated responses, rounding, or clock skew.
                if (timing && timing.start === t.start) timing = { ...t, deadline: Math.min(timing.deadline, t.deadline) };
                else if (!timing || t.start >= timing.end) timing = { ...t };
            },
            seconds() { return timing ? Math.max(0, Math.ceil((timing.deadline - now()) / 1000)) : null; },
            reset() { timing = null; newest = -Infinity; sources.clear(); }
        };
    }
    function createCore(config, nativeFetch, emit = () => {}, now = Date.now, onVariants = () => {}, timingReader = null) {
        const cfg = { timeout: 3500, cacheTTL: 60000, maxEntries: 512,
            retryDelay: 15000, maxAttempts: 3, ...config };
        const attrs = line => Object.fromEntries([...line.slice(line.indexOf(':') + 1)
            .matchAll(/([A-Z0-9-]+)=("[^"]*"|[^,]*)/g)]
            .map(m => [m[1], m[2].replace(/^"|"$/g, '')]));
        const absolute = (url, base) => new URL(url, base).href;
        const hostOK = url => { try { return /(^|\.)(ttvnw\.net|twitch\.tv)$/.test(new URL(url).hostname); } catch { return false; } };
        const playlistURL = url => hostOK(url) && /\.m3u8$/i.test(new URL(url).pathname);
        const adTag = line => /^#EXT-X-DATERANGE:/.test(line) &&
            (/(?:CLASS|ID)="(?:twitch-stitched-ad|stitched-ad)(?:["-])/.test(line) || /X-TV-TWITCH-AD-[A-Z-]+=/.test(line));
        class Cache {
            constructor(limit = cfg.maxEntries, ttl = cfg.cacheTTL) { this.map = new Map(); this.limit = limit; this.ttl = ttl; }
            get(key) { const item = this.map.get(key); if (!item) return undefined;
                if (item.until <= now()) { this.map.delete(key); return undefined; } return item.value; }
            set(key, value) { this.map.delete(key); this.map.set(key, { value, until: now() + this.ttl });
                while (this.map.size > this.limit) this.map.delete(this.map.keys().next().value); }
            clear() { this.map.clear(); }
        }
        const variants = new Cache(128, 21600000), denied = new Cache(2048, 180000), ranges = new Cache(128, 180000);
        const sessions = new Cache(8, 45000), controllers = new Set(), routes = new Cache(8, 21600000), delivered = new Cache(128, 21600000);
        const mediaCache = new Cache(8, 400), routeJobs = new Map(), mediaJobs = new Map();
        const metrics = { playlistRequests: 0, lastPlaylistMs: 0, lastParseMs: 0, lastDetectionProcessingMs: 0, lastLookupMs: 0, gqlFailures: 0, secondaryTokenBlocks: 0 };
        let rendition = {}, playbackKey = null;
        const safeURL = value => {
            try { const u = new URL(value); return { host: u.hostname, path: u.pathname.split('/').map(p =>
                !p || /^(?:source|chunked|index|playlist|live|\d+p?\d*)\.m3u8$/.test(p) ? p : '[redacted]').join('/') }; }
            catch { return null; }
        };
        const qualitySnapshot = q => q ? { resolution: q.resolution, fps: q.fps, codecs: q.codecs,
            bandwidth: q.bandwidth ?? null, averageBandwidth: q.averageBandwidth ?? null, url: safeURL(q.url),
            audioGroupPresent: !!q.audio, videoGroupPresent: !!q.video,
            audioRenditions: (q.audioRenditions || []).map(a => ({ channels: a.channels || null, external: !!a.uri })) } : null;
        function renditionDiagnostics() {
            return JSON.parse(JSON.stringify({ ...rendition, timeSinceLastAdvancingPlaylistMs:
                Number.isFinite(rendition.lastProgressAt) ? Math.max(0, now() - rendition.lastProgressAt) : null }));
        }
        function recordMedia(parsed, url, quality, session, refreshAttempts = 0) {
            const seq = parsed.segments.at(-1)?.sequence;
            if (!Number.isFinite(seq)) return;
            const key = session + ':' + url;
            if (key !== playbackKey || seq > rendition.lastMediaSequence) {
                rendition.lastProgressAt = now(); rendition.lastMediaSequence = seq; playbackKey = key;
            }
            rendition.current = qualitySnapshot(quality); rendition.currentURL = safeURL(url);
            rendition.session = session; rendition.usingAlternative = session === 'alternative';
            rendition.fallbackRefreshAttempts = refreshAttempts;
        }
        let rtt = null, episodeType = 'unknown', timing = null, timingSerial = 0;
        let timingClock = null, timingDiagnostics = { available: false, reason: 'no-playlist-observed' };
        let noticeEvidence = null, noticeSerial = 0, eventStart = null, eventEnd = null;
        function observeNotice(parsed, id) {
            if (id < noticeSerial) return;
            noticeSerial = id;
            const dates = parsed.segments.filter(s => Number.isFinite(s.time));
            if (parsed.hasAds) {
                const adRanges = parsed.ranges.filter(r => parsed.segments.some(s => s.ad && s.time < r.end && s.time + s.duration * 1000 > r.start));
                eventStart = adRanges.length ? Math.min(...adRanges.map(r => r.start)) : null;
                eventEnd = adRanges.length ? Math.max(...adRanges.map(r => r.end)) : null;
            }
            noticeEvidence = { eventStart, eventEnd, ambiguous: parsed.ambiguous, confirmed: parsed.segments.some(s => s.ad), sequence: parsed.segments.at(-1)?.sequence ?? null,
                mediaStart: dates.length === parsed.segments.length && dates.length ? dates[0].time : null,
                mediaEnd: dates.length === parsed.segments.length && dates.length ? dates.at(-1).time + dates.at(-1).duration * 1000 : null };
        }
        function learnClock(sample) {
            if (!timingReader || !sample || ![sample.serverNow, sample.observedAt].every(Number.isFinite) ||
                !['http-date', 'twitch-server-time'].includes(sample.source)) return;
            const age = performance.timeOrigin + performance.now() - sample.observedAt;
            if (age < -1000 || age > 60000 || (timingClock &&
                (sample.observedAt < timingClock.observedAt || (sample.stamp ?? sample.serverNow) <= (timingClock.stamp ?? timingClock.serverNow)))) return;
            timingClock = { ...sample };
        }
        let channel = '', generation = 0, active = false, state = 'IDLE', attempts = 0, nextTry = 0, pending = null;
        let requestSerial = 0, latestCommit = 0, cleanSequence = -1, cleanCount = 0, activeAlternative = null;
        let failure = null, lastFailure = null, recoveryBoundary = null, lastReason = '', lastReport = null;
        function openCircuit(category = 'advertisement-segment-suppression', playerFault = false) {
            if (failure) {
                if ((failure.category !== category && ['media-decoding-failure', 'player-recovery-failure'].includes(category)) || (playerFault && failure.retryable)) {
                    failure = { ...failure, category, retryable: false }; lastFailure = { ...failure }; notify('BLOCKING', 'controlled-failure', { limited: true, playbackVerified: false });
                }
                return;
            }
            failure = { category, mode: routes.map.size ? 'hold-session' : 'native-playback', adFree: false,
                detail: playerFault ? 'native-player-error' : lastReason,
                retryable: !playerFault && !['media-decoding-failure', 'player-recovery-failure'].includes(category) && !routes.map.size, at: now(), eventStart };
            lastFailure = { ...failure }; recoveryBoundary = null; cleanCount = 0; cleanSequence = -1;
            denied.clear(); activeAlternative = null;
            notify('BLOCKING', 'controlled-failure', { limited: true, supplied: 0, suppressed: 0, playbackVerified: false });
        }
        function notify(next, reason, extra = {}) {
            state = next; lastReason = reason;
            lastReport = { state, reason, channel, generation, adType: episodeType, timing, failure, lastFailure,
                blockingApplied: false, ambiguous: noticeEvidence?.ambiguous || false, evidenceState: reason === 'confirmed-ad-metadata' ? 'ad-confirmed' :
                reason === 'examining-exact-quality-alternative' ? 'attempt-started' : reason === 'controlled-failure' ? 'unsuccessful' :
                reason === 'clean-playlists-advancing' ? 'completed' : extra.supplied > 0 ? 'replacement-available' : 'observed',
                network: { ...metrics, timing: timingDiagnostics, notice: noticeEvidence, rendition: renditionDiagnostics() }, ...extra };
            emit(lastReport);
        }
        function reset(login = '') {
            generation++; channel = login; active = false; state = 'IDLE'; attempts = 0; nextTry = 0; timing = null; timingSerial = 0; failure = null; lastFailure = null; recoveryBoundary = null;
            timingClock = null; timingDiagnostics = { available: false, reason: 'channel-reset' };
            rendition = { session: 'original', usingAlternative: false, exactFallbackAvailable: null,
                candidateRejection: null, lastMediaSequence: null, lastProgressAt: null, fallbackRefreshAttempts: 0, exactCandidatesConsidered: 0,
                exactCandidatesTried: 0, selectedCandidateRank: null, selectedPlayerType: null };
            playbackKey = null;
            noticeEvidence = null; noticeSerial = 0; eventStart = null; eventEnd = null;
            cleanSequence = -1; cleanCount = 0; latestCommit = ++requestSerial; pending = null;
            for (const controller of controllers) controller.abort(); controllers.clear();
            activeAlternative = null; episodeType = 'unknown'; routes.clear(); delivered.clear(); mediaCache.clear(); routeJobs.clear(); mediaJobs.clear();
            variants.clear(); denied.clear(); ranges.clear(); sessions.clear(); notify('IDLE', 'channel-reset');
        }
        function master(text, url) {
            const lines = text.replace(/\r/g, '').split('\n'), result = [];
            const groups = lines.filter(l => l.startsWith('#EXT-X-MEDIA:')).map(l => {
                const a = attrs(l);
                return { type: a.TYPE, group: a['GROUP-ID'], name: a.NAME, language: a.LANGUAGE,
                    channels: a.CHANNELS, default: a.DEFAULT === 'YES', autoselect: a.AUTOSELECT === 'YES',
                    uri: a.URI ? absolute(a.URI, url) : null };
            });
            for (let i = 0; i < lines.length; i++) {
                if (!lines[i].startsWith('#EXT-X-STREAM-INF:')) continue;
                const a = attrs(lines[i]); let j = i + 1;
                while (j < lines.length && (!lines[j].trim() || lines[j].startsWith('#'))) j++;
                if (j >= lines.length) continue;
                const uri = absolute(lines[j].trim(), url);
                if (!hostOK(uri)) continue;
                result.push({ url: uri, resolution: a.RESOLUTION, fps: Number(a['FRAME-RATE']),
                    codecs: a.CODECS, bandwidth: Number(a.BANDWIDTH) || null,
                    averageBandwidth: Number(a['AVERAGE-BANDWIDTH']) || null,
                    audio: a.AUDIO, video: a.VIDEO, name: a.VIDEO || a.NAME || '',
                    audioRenditions: groups.filter(g => g.type === 'AUDIO' && g.group === a.AUDIO),
                    videoRenditions: groups.filter(g => g.type === 'VIDEO' && g.group === a.VIDEO) });
            }
            return result;
        }
        function exact(a, b) {
            // A VIDEO label may simply identify the rendition. Only reject video
            // groups that actually require additional external media streams.
            const externalVideo = q => (q?.videoRenditions || []).some(v => !!v.uri);
            return !!a && !!b && /^[1-9]\d*x[1-9]\d*$/.test(a.resolution || '') && a.resolution === b.resolution &&
                Number.isFinite(a.fps) && a.fps > 0 && a.fps === b.fps && !!a.codecs && a.codecs === b.codecs &&
                !a.audio && !b.audio && !externalVideo(a) && !externalVideo(b);
        }
        function qualityFor(url) {
            const direct = variants.get(url); if (direct) return direct;
            const target = new URL(url), matches = [];
            for (const key of variants.map.keys()) {
                const candidate = variants.get(key), parsed = new URL(key);
                if (candidate && parsed.origin === target.origin && parsed.pathname === target.pathname) matches.push(candidate);
            }
            return matches.length && matches.every(q => exact(matches[0], q)) ? matches[0] : undefined;
        }
        function learnVariants(list) {
            if (!Array.isArray(list)) return;
            for (const v of list.slice(0, 128)) if (v && playlistURL(v.url) && /^[1-9]\d*x[1-9]\d*$/.test(v.resolution || '') &&
                Number.isFinite(v.fps) && v.fps > 0 && typeof v.codecs === 'string') variants.set(v.url, v);
        }
        function media(text, url, remembered = []) {
            const lines = text.replace(/\r/g, '').split('\n');
            const localRanges = new Map(remembered.map(r => [r.id, r]));
            let evidence = false, unknownRange = false, type = 'unknown';
            for (const line of lines) {
                if (!adTag(line)) continue;
                evidence = true; const a = attrs(line), start = Date.parse(a['START-DATE']);
                const endDate = Date.parse(a['END-DATE']);
                const duration = Number(a.DURATION || a['PLANNED-DURATION']);
                const end = Number.isFinite(endDate) ? endDate : start + duration * 1000;
                const rangeType = /midroll/i.test(line) ? 'midroll' : /preroll/i.test(line) ? 'preroll' : 'unknown';
                if (Number.isFinite(start) && Number.isFinite(end) && end > start && end - start <= 600000)
                    localRanges.set(a.ID || String(start), { id: a.ID || String(start), start, end, type: rangeType });
                else unknownRange = true;
            }
            const segments = []; let sequence = 0, discontinuity = 0, time = NaN, duration = NaN;
            let title = '', index = -1, key = false, map = false, byteRange = false, gap = false, cue = false;
            let unsupported = !text.startsWith('#EXTM3U') || /#EXT-X-(?:SKIP|PART|PRELOAD-HINT):/.test(text);
            for (let i = 0; i < lines.length; i++) {
                const line = lines[i].trim();
                if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) sequence = Number(line.split(':')[1]);
                else if (line.startsWith('#EXT-X-DISCONTINUITY-SEQUENCE:')) discontinuity = Number(line.split(':')[1]);
                else if (line === '#EXT-X-DISCONTINUITY') { discontinuity++; time = NaN; }
                else if (line.startsWith('#EXT-X-PROGRAM-DATE-TIME:')) time = Date.parse(line.slice(25));
                else if (line.startsWith('#EXT-X-KEY:')) key = attrs(line).METHOD !== 'NONE';
                else if (line.startsWith('#EXT-X-MAP:')) map = true;
                else if (line.startsWith('#EXT-X-BYTERANGE:')) byteRange = true;
                else if (line === '#EXT-X-GAP') gap = true;
                else if (line.startsWith('#EXT-X-CUE-OUT')) cue = true;
                else if (line.startsWith('#EXT-X-CUE-IN')) cue = false;
                else if (line.startsWith('#EXTINF:')) { duration = Number(line.slice(8).split(',')[0]); title = line.slice(line.indexOf(',') + 1); index = i; }
                else if (line && !line.startsWith('#')) {
                    if (!(duration > 0) || index < 0) { unsupported = true; continue; }
                    const uri = absolute(line, url);
                    const methods = [];
                    if (/^(?:stitched-ad|twitch-stitched-ad)(?:$|[ ,:])/i.test(title)) methods.push('segment-title');
                    if (Number.isFinite(time) && [...localRanges.values()].some(r => time < r.end && time + duration * 1000 > r.start)) methods.push('dated-ad-range');
                    if (cue && evidence) methods.push('cue-with-twitch-metadata');
                    segments.push({ uri, duration, time, sequence: sequence++, discontinuity, index, uriIndex: i,
                        key, map, byteRange, gap, ad: methods.length > 0, methods });
                    time += duration * 1000; duration = NaN; index = -1; byteRange = false; gap = false;
                }
            }
            if (!segments.length || index >= 0) unsupported = true;
            const currentTypes = new Set([...localRanges.values()].filter(r => segments.some(s => s.ad &&
                Number.isFinite(s.time) && s.time < r.end && s.time + s.duration * 1000 > r.start))
                .map(r => r.type).filter(t => t && t !== 'unknown'));
            if (currentTypes.size === 1) type = [...currentTypes][0];
            // Metadata without a time mapping cannot safely identify individual segments.
            const ambiguous = evidence && (unknownRange || segments.some(s => !Number.isFinite(s.time))) && !segments.some(s => s.ad);
            return { lines, segments, ranges: [...localRanges.values()].slice(-128), evidence, ambiguous, unsupported, type,
                hasAds: segments.some(s => s.ad) || ambiguous };
        }
        async function request(url, init = {}, signal, adaptive = false) {
            const controller = new AbortController(); controllers.add(controller);
            const cancel = () => controller.abort(); signal?.addEventListener('abort', cancel, { once: true });
            if (signal?.aborted) cancel();
            const started = now();
            const timingStarted = timingReader ? performance.now() : null;
            const budget = adaptive && rtt !== null ? Math.min(cfg.timeout, Math.max(Math.min(800, cfg.timeout), rtt * 4)) : cfg.timeout;
            const timer = setTimeout(cancel, budget);
            try {
                const response = await nativeFetch(url, { ...init, signal: controller.signal, cache: 'no-store' });
                if (!response.ok) throw new Error(response.status === 401 || response.status === 403 ? 'credentials-rejected' : 'http-failure');
                const text = await response.text();
                if (text.length > 2000000) throw new Error('playlist-too-large');
                rtt = rtt === null ? now() - started : rtt * 0.75 + (now() - started) * 0.25;
                const serverNow = Date.parse(response.headers.get('date'));
                const elapsed = timingReader ? performance.now() - timingStarted : Infinity;
                // HTTP Date is rounded to seconds. Use its upper bound and the full
                // round trip so the display cannot overstate remaining server time.
                let clock = timingReader && Number.isFinite(serverNow) && Number(response.headers.get('age') || 0) === 0 && elapsed >= 0 && elapsed <= 1000
                    ? { serverNow: serverNow + 1000 + elapsed, stamp: serverNow, source: 'http-date', observedAt: performance.timeOrigin + performance.now() } : null;
                if (timingReader && text.startsWith('#EXTM3U') && Number(response.headers.get('age') || 0) === 0 && elapsed >= 0 && elapsed <= 1000) {
                    const stamps = text.split('\n').flatMap(line => {
                        if (line.startsWith('#EXT-X-TWITCH-INFO:')) return [Number(attrs(line)['SERVER-TIME']) * 1000];
                        if (line.startsWith('#EXT-X-SESSION-DATA:')) { const a = attrs(line); if (a['DATA-ID'] === 'SERVER-TIME') return [Number(a.VALUE) * 1000]; }
                        return [];
                    }).filter(n => Number.isFinite(n) && n > 946684800000 && n < 4102444800000);
                    if (stamps.length && stamps.every(n => Math.abs(n - stamps[0]) < 1) &&
                        (!Number.isFinite(serverNow) || Math.abs(stamps[0] - serverNow) <= 2000)) {
                        clock = { serverNow: stamps[0] + elapsed, stamp: stamps[0], source: 'twitch-server-time', observedAt: performance.timeOrigin + performance.now() };
                    }
                }
                return { response, text, clock };
            } catch (error) { throw new Error(controller.signal.aborted ? 'request-aborted-or-timeout' :
                ['credentials-rejected', 'http-failure', 'playlist-too-large'].includes(error.message) ? error.message : 'network-failure'); }
            finally { clearTimeout(timer); controllers.delete(controller); signal?.removeEventListener('abort', cancel); }
        }
        async function candidateMedia(quality, signal) {
            const cached = mediaCache.get(quality.url);
            if (cached && !cached.parsed.segments.some(s => denied.get(s.uri))) return cached;
            const epoch = generation, key = epoch + ':' + quality.url;
            let job = mediaJobs.get(key);
            if (!job) {
                job = (async () => {
                    const fetched = await request(quality.url, {}, signal, true), base = fetched.response.url || quality.url;
                    if (epoch !== generation || signal?.aborted) throw new Error('navigation-cancelled');
                    const parsed = media(fetched.text, base);
                    if (!validMedia(parsed) || parsed.hasAds || parsed.evidence || parsed.unsupported || parsed.segments.some(s => s.gap || denied.get(s.uri)) || parsed.lines.includes('#EXT-X-ENDLIST')) throw new Error('alternative-contains-ads-or-unknown-format');
                    const result = { parsed, quality, text: parsed.lines.map(line => line && !line.startsWith('#') ? absolute(line, base) : line).join('\n') };
                    mediaCache.set(quality.url, result); return result;
                })();
                mediaJobs.set(key, job);
                job.finally(() => { if (mediaJobs.get(key) === job) mediaJobs.delete(key); }).catch(() => {});
            }
            const result = await job;
            return { ...result, quality }; // Metadata always belongs to this candidate's master.
        }
        async function alternative(quality, signal, epoch, usable) {
            const started = now(), race = new AbortController();
            const cancel = () => race.abort(); signal?.addEventListener('abort', cancel, { once: true });
            const discoveryTimer = setTimeout(cancel, Math.min(cfg.timeout, 1500));
            if (signal?.aborted) cancel();
            const login = channel;
            const check = async playerType => {
                const cacheKey = login + ':' + playerType;
                let fetchingToken = false;
                try {
                    if (generation !== epoch || race.signal.aborted) throw new Error('navigation-cancelled');
                    if (activeAlternative?.playerType === playerType && exact(quality, activeAlternative.quality)) {
                        try {
                            const found = await candidateMedia(activeAlternative.quality, race.signal);
                            if (usable(found)) return { ...found, playerType };
                        } catch { sessions.map.delete(cacheKey); }
                    }
                    let candidates = sessions.get(cacheKey);
                    if (!candidates) {
                        fetchingToken = true;
                        const tokenResult = await request('https://gql.twitch.tv/gql', {
                            method: 'POST', headers: { 'Client-ID': 'kimne78kx3ncx6brgo4mv6wki5h1ko', 'Content-Type': 'text/plain;charset=UTF-8' },
                            body: JSON.stringify({ operationName: 'QualityGuardToken', variables: { login, playerType },
                                query: 'query QualityGuardToken($login: String!, $playerType: String!) { streamPlaybackAccessToken(channelName: $login, params: {platform: "web", playerBackend: "mediaplayer", playerType: $playerType}) { value signature } }' })
                        }, race.signal, true);
                        fetchingToken = false;
                        let json;
                        try { json = JSON.parse(tokenResult.text); } catch { metrics.gqlFailures++; throw new Error('token-unavailable'); }
                        const token = json.data?.streamPlaybackAccessToken;
                        if (json.errors || !token?.value || !token?.signature) { metrics.gqlFailures++; throw new Error('token-unavailable'); }
                        const url = new URL('https://usher.ttvnw.net/api/channel/hls/' + encodeURIComponent(login) + '.m3u8');
                        url.search = new URLSearchParams({ sig: token.signature, token: token.value, allow_source: 'true', allow_audio_only: 'true', player: playerType }).toString();
                        const fetched = await request(url.href, {}, race.signal, true);
                        candidates = master(fetched.text, fetched.response.url || url.href);
                        if (generation !== epoch || race.signal.aborted) throw new Error('navigation-cancelled');
                        sessions.set(cacheKey, candidates);
                    }
                    const matches = candidates.filter(q => exact(quality, q)).sort((a, b) =>
                        Number(b.name === quality.name) - Number(a.name === quality.name) ||
                        Math.abs((a.averageBandwidth || a.bandwidth || 0) - (quality.averageBandwidth || quality.bandwidth || 0)) -
                        Math.abs((b.averageBandwidth || b.bandwidth || 0) - (quality.averageBandwidth || quality.bandwidth || 0)));
                    if (generation === epoch && !race.signal.aborted)
                        rendition.exactCandidatesConsidered = Math.max(rendition.exactCandidatesConsidered || 0, matches.length);
                    if (!matches.length) {
                        if (generation === epoch && !race.signal.aborted) rendition.candidateRejection = quality.audio ? 'separate-audio-group-unsupported' : 'no-exact-resolution-fps-codecs';
                        throw new Error('no-exact-quality-alternative');
                    }
                    let rejected;
                    // Keep the existing discovery deadline and cap work within each branch.
                    for (const [index, candidate] of matches.slice(0, 4).entries()) {
                        if (generation !== epoch || race.signal.aborted) throw new Error('navigation-cancelled');
                        if (generation === epoch) rendition.exactCandidatesTried = (rendition.exactCandidatesTried || 0) + 1;
                        try {
                            const result = await candidateMedia(candidate, race.signal);
                            if (!usable(result)) throw new Error('timeline-not-compatible');
                            return { ...result, playerType, candidateRank: index + 1 };
                        } catch (error) {
                            rejected = error;
                            if (generation === epoch && !race.signal.aborted) rendition.candidateRejection =
                                ['timeline-not-compatible', 'alternative-contains-ads-or-unknown-format', 'credentials-rejected',
                                    'request-aborted-or-timeout', 'http-failure', 'network-failure'].includes(error.message) ? error.message : 'candidate-unavailable';
                        }
                    }
                    throw rejected || new Error('no-playable-exact-candidate');
                } catch (error) {
                    if (fetchingToken && !race.signal.aborted) metrics.gqlFailures++;
                    if (!race.signal.aborted) sessions.map.delete(cacheKey);
                    throw error;
                }
            };
            try {
                const result = await Promise.any(['embed', 'popout'].map(check));
                if (epoch !== generation || signal?.aborted) throw new Error('navigation-cancelled');
                rendition.exactFallbackAvailable = true;
                rendition.selectedPlayerType = result.playerType;
                rendition.selectedCandidateRank = result.candidateRank ?? null;
                rendition.candidateRejection = null;
                activeAlternative = { quality: result.quality, playerType: result.playerType }; return result;
            } catch (error) {
                if (generation === epoch) activeAlternative = null;
                const known = ['credentials-rejected', 'token-unavailable', 'request-aborted-or-timeout', 'no-exact-quality-alternative', 'timeline-not-compatible', 'alternative-contains-ads-or-unknown-format'];
                const reason = error.errors?.map(e => e.message).find(s => known.includes(s)) || 'alternative-request-failed';
                if (generation === epoch) { rendition.exactFallbackAvailable = false; rendition.candidateRejection = reason === 'no-exact-quality-alternative' ? rendition.candidateRejection : reason; }
                return { reason };
            } finally { clearTimeout(discoveryTimer); cancel(); signal?.removeEventListener('abort', cancel); metrics.lastLookupMs = now() - started; }
        }
        function replacements(original, backup) {
            const result = new Map();
            if (!backup) return result;
            // A shared, identical content segment anchors the two sessions to the same media timeline.
            const anchors = original.segments.filter(s => !s.ad && Number.isFinite(s.time)).flatMap(s => backup.segments
                .filter(b => !b.ad && s.uri === b.uri && s.time === b.time && s.duration === b.duration)
                .map(b => ({ sequence: b.sequence - s.sequence, discontinuity: b.discontinuity - s.discontinuity })));
            if (!anchors.length || anchors.some(a => a.sequence !== anchors[0].sequence || a.discontinuity !== anchors[0].discontinuity)) return result;
            const offset = anchors[0];
            for (const s of original.segments.filter(s => s.ad)) {
                const b = backup.segments.find(b => !b.ad && !b.gap && Number.isFinite(b.time) &&
                    b.time === s.time && b.duration === s.duration && b.sequence === s.sequence + offset.sequence &&
                    b.discontinuity === s.discontinuity + offset.discontinuity && !b.key && !b.map && !b.byteRange);
                if (b && b.uri !== s.uri && !s.key && !s.map && !s.byteRange && /\.ts(?:\?|$)/.test(b.uri)) result.set(s.uriIndex, b.uri);
            }
            return result;
        }
        function rewrite(parsed, replacement) {
            const lines = parsed.lines.slice();
            const version = lines.findIndex(line => line.startsWith('#EXT-X-VERSION:'));
            if (version >= 0 && Number(lines[version].split(':')[1]) < 6) lines[version] = '#EXT-X-VERSION:6';
            for (const s of parsed.segments) if (s.ad) {
                // Retain sequence, duration, discontinuity, encryption and timestamp metadata.
                // GAP describes unavailable media; it is not a fake decoder payload.
                lines[s.uriIndex] = replacement.get(s.uriIndex) || (s.gap ? s.uri : '#EXT-X-GAP\n' + s.uri);
                if (replacement.has(s.uriIndex)) lines[s.index] = lines[s.index].replace(/,.*/, ',live');
            }
            if (version < 0) lines[0] += '\n#EXT-X-VERSION:6';
            const fullyReplaced = replacement.size > 0 && replacement.size === parsed.segments.filter(s => s.ad).length;
            return lines.filter(line => !(fullyReplaced && adTag(line)) && !/^#EXT-X-(?:TWITCH-PREFETCH|PREFETCH|RENDITION-REPORT)/.test(line)).join('\n');
        }
        function awaitResult(job, signal) {
            if (!signal) return job;
            if (signal.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'));
            return new Promise((resolve, reject) => {
                const cancel = () => reject(new DOMException('Aborted', 'AbortError'));
                signal.addEventListener('abort', cancel, { once: true });
                job.then(resolve, reject).finally(() => signal.removeEventListener('abort', cancel));
            });
        }
        function startLookup(quality, epoch, usable) {
            const deadline = new AbortController(); controllers.add(deadline);
            const timer = setTimeout(() => deadline.abort(), cfg.timeout * 2);
            const job = alternative(quality, deadline.signal, epoch, usable); pending = job;
            job.finally(() => { clearTimeout(timer); controllers.delete(deadline); if (pending === job) pending = null; }).catch(() => {});
            return job;
        }
        function validMedia(parsed) {
            const target = parsed.lines.find(l => /^#EXT-X-TARGETDURATION:[1-9]\d*\s*$/.test(l));
            const duration = Number(target?.split(':')[1]);
            return !parsed.unsupported && parsed.segments.length > 0 && Number.isFinite(duration) && parsed.segments.every(s =>
                Number.isFinite(s.duration) && s.duration > 0 && Math.round(s.duration) <= duration &&
                Number.isSafeInteger(s.sequence) && s.sequence >= 0 && Number.isSafeInteger(s.discontinuity) && s.discontinuity >= 0 && hostOK(s.uri));
        }
        const simpleMedia = parsed => validMedia(parsed) && parsed.segments.every(s => !s.key && !s.map && !s.byteRange && !s.gap && /\.ts(?:\?|$)/.test(s.uri));
        function sharedAnchor(a, b) {
            return a.segments.some(s => !s.ad && Number.isFinite(s.time) && b.segments.some(t =>
                !t.ad && t.uri === s.uri && t.sequence === s.sequence && t.discontinuity === s.discontinuity && t.time === s.time));
        }
        async function process(text, url, signal, id = ++requestSerial, clock = null) {
            const epoch = generation, parseStarted = now();
            learnClock(clock);
            if (text.includes('#EXT-X-STREAM-INF:')) {
                const list = master(text, url); for (const v of list) variants.set(v.url, v); onVariants(list, timingClock);
                return text;
            }
            if (timingReader && id >= timingSerial) {
                timingSerial = id;
                const observedAt = performance.timeOrigin + performance.now();
                const age = timingClock ? observedAt - timingClock.observedAt : Infinity;
                const anchor = clock || (age >= 0 && age <= 60000 ? { ...timingClock,
                    serverNow: timingClock.serverNow + age, observedAt } : null);
                timingDiagnostics = { available: false, reason: 'no-usable-timing', clockSource: anchor?.source || null };
                try {
                    timing = timingReader(text, anchor, reason => { timingDiagnostics.reason = reason; });
                    if (timing) timingDiagnostics = { available: true, reason: 'actual-duration-and-server-clock', clockSource: timing.clockSource, scope: timing.scope };
                } catch { timing = null; timingDiagnostics.reason = 'timing-parser-error'; }
            }
            const rangeKey = new URL(url).origin + new URL(url).pathname;
            const route = routes.get(rangeKey);
            const requestedQuality = qualityFor(url);
            rendition.original = qualitySnapshot(requestedQuality);
            if (route && requestedQuality && !exact(requestedQuality, route.quality)) {
                // A viewer-selected quality change is not a playback fault. The old
                // pinned rendition is no longer appropriate, so let Twitch's own
                // selected rendition through and allow future ad attempts normally.
                routes.map.delete(rangeKey); mediaCache.map.delete(route.quality.url);
                activeAlternative = null; denied.clear(); attempts = 0; nextTry = 0;
                rendition.candidateRejection = 'selected-rendition-changed';
                rendition.exactFallbackAvailable = null;
                rendition.lastRecoveryAction = { action: 'viewer-rendition-changed-native', at: now() };
                recordMedia(media(text, url), url, requestedQuality, 'original');
                if (generation === epoch && id >= latestCommit) {
                    latestCommit = id; active = false; cleanCount = 0; cleanSequence = -1;
                    notify('IDLE', 'viewer-rendition-changed');
                }
                return text;
            }
            let parsed = media(text, url, ranges.get(url) || []);
            if (route && !parsed.evidence) {
                const fresh = media(text, url);
                // The original may rejoin the proven clean session. Do not let remembered
                // dates from its former ad timeline poison these identical content URIs.
                const confirmedContent = parsed.segments.filter(s => s.ad).every(s => route.parsed.segments.some(t =>
                    !t.ad && t.uri === s.uri && t.time === s.time && t.sequence === s.sequence && t.discontinuity === s.discontinuity));
                if (!fresh.hasAds && !fresh.unsupported && confirmedContent && sharedAnchor(fresh, route.parsed)) parsed = fresh;
            }
            observeNotice(parsed, id);
            metrics.lastParseMs = now() - parseStarted;
            if (parsed.hasAds) metrics.lastDetectionProcessingMs = metrics.lastParseMs;
            ranges.set(url, parsed.ranges);
            for (const s of parsed.segments) if (s.ad) denied.set(s.uri, true);
            const current = () => generation === epoch && id >= latestCommit;
            if (route) {
                if (!parsed.hasAds && !parsed.unsupported && sharedAnchor(parsed, route.parsed)) {
                    routes.map.delete(rangeKey); // A real common segment permits return to the original timeline.
                    rendition.lastRecoveryAction = { action: 'rejoin-original-shared-anchor', at: now() };
                } else {
                    let job = routeJobs.get(rangeKey);
                    if (!job) {
                        const lastSequence = route.parsed.segments.at(-1).sequence;
                        const validateProgress = result => {
                            if (generation !== epoch) throw new Error('navigation-cancelled');
                            const sequence = result.parsed.segments.at(-1).sequence;
                            if (sequence < lastSequence) throw new Error('alternative-sequence-regressed');
                            const target = Number(route.parsed.lines.find(l => l.startsWith('#EXT-X-TARGETDURATION:'))?.split(':')[1]) || 0;
                            if (sequence === lastSequence && now() - route.advancedAt > Math.max(15000, target * 3000)) throw new Error('alternative-playlist-stale');
                            return result;
                        };
                        job = candidateMedia(route.quality).then(validateProgress).catch(async error => {
                            if (generation !== epoch || pending || (route.refreshAttempts || 0) >= 2 || now() < (route.nextRefresh || 0)) throw error;
                            route.refreshAttempts = (route.refreshAttempts || 0) + 1; route.nextRefresh = now() + cfg.retryDelay;
                            rendition.fallbackRefreshAttempts = route.refreshAttempts;
                            rendition.lastRecoveryAction = { action: 'renew-exact-session', at: now(), reason: error.message };
                            // A frozen successful HTTP response needs the same renewal path as
                            // expired credentials. Do not rediscover its cached session.
                            mediaCache.map.delete(route.quality.url); sessions.clear(); activeAlternative = null;
                            const stale = error.message === 'alternative-playlist-stale' || error.message === 'alternative-sequence-regressed';
                            const renewed = await startLookup(route.quality, epoch, result => exact(route.quality, result.quality) &&
                                sharedAnchor(route.parsed, result.parsed) && (!stale || result.parsed.segments.at(-1).sequence > lastSequence));
                            if (!renewed.parsed) throw error;
                            validateProgress(renewed); route.quality = renewed.quality; return renewed;
                        }).then(result => {
                            if (generation !== epoch) throw new Error('navigation-cancelled');
                            if (result.parsed.segments.at(-1).sequence > route.parsed.segments.at(-1).sequence) route.advancedAt = now();
                            route.parsed = result.parsed; route.text = result.text; return result.text;
                        });
                        routeJobs.set(rangeKey, job);
                        job.finally(() => { if (routeJobs.get(rangeKey) === job) routeJobs.delete(rangeKey); }).catch(() => {});
                    }
                    try {
                        const result = await awaitResult(job, signal);
                        if (generation !== epoch) throw new Error('navigation-cancelled');
                        if (current()) {
                            latestCommit = id;
                            recordMedia(route.parsed, route.quality.url, route.quality, 'alternative', route.refreshAttempts || 0);
                            if (parsed.hasAds) {
                                cleanCount = 0; cleanSequence = -1;
                                if (!active) { active = true; episodeType = parsed.type; notify('AD_DETECTED', 'confirmed-ad-metadata'); }
                                notify('BLOCKING', 'exact-quality-startup-session', { supplied: route.parsed.segments.length, suppressed: 0, limited: false, playbackVerified: false,
                                    adEvidence: parsed.segments.filter(s => s.ad).length, ambiguous: parsed.ambiguous });
                            }
                            else {
                                const seq = parsed.segments.at(-1)?.sequence ?? -1;
                                if (seq > cleanSequence) { cleanSequence = seq; cleanCount++; }
                                notify(cleanCount >= 2 ? 'IDLE' : 'RECOVERING', cleanCount >= 2 ? 'clean-playlists-advancing' : 'clean-playlist-observed');
                                if (cleanCount >= 2) active = false;
                            }
                        }
                        return result;
                    } catch (error) {
                        if (generation !== epoch || signal?.aborted) throw error;
                        if (current()) notify('BLOCKING', 'startup-session-unavailable', { limited: true, playbackVerified: false });
                        // Do not splice the original session's unrelated sequence/timestamps into this session.
                        throw new Error('startup-session-unavailable');
                    }
                }
            }
            if (!parsed.hasAds) {
                delivered.set(rangeKey, true);
                if (current()) recordMedia(parsed, url, requestedQuality, 'original');
                if (current() && active && !parsed.unsupported) {
                    latestCommit = id;
                    const seq = parsed.segments.at(-1)?.sequence ?? -1;
                    if (seq > cleanSequence) { cleanSequence = seq; cleanCount++; }
                    notify('RECOVERING', 'clean-playlist-observed');
                    if (cleanCount >= 2) { active = false; attempts = 0; nextTry = 0; activeAlternative = null; notify('IDLE', 'clean-playlists-advancing'); }
                }
                else if (current() && !active) notify('IDLE', 'native-playlist');
                return text;
            }
            if (parsed.ambiguous) {
                if (current()) notify('OBSERVED', 'ambiguous-ad-metadata', { ambiguous: true, adEvidence: 0, timing: null });
                return text;
            }
            if (current()) {
                latestCommit = id; cleanCount = 0; cleanSequence = -1;
                if (!active) { active = true; episodeType = parsed.type; notify('AD_DETECTED', 'confirmed-ad-metadata', { adType: parsed.type, ambiguous: parsed.ambiguous, adEvidence: parsed.segments.filter(s => s.ad).length }); }
                notify('BLOCKING', 'examining-exact-quality-alternative', { methods: [...new Set(parsed.segments.flatMap(s => s.methods))] });
            }
            if (parsed.ambiguous || parsed.unsupported) {
                if (current()) notify('BLOCKING', 'unsupported-ad-playlist', { limited: true });
                throw new Error('ad-playlist-withheld');
            }
            const quality = qualityFor(url);
            const startup = !delivered.get(rangeKey) && parsed.segments.every(s => s.ad);
            const usable = result => exact(quality, result.quality) &&
                (startup && simpleMedia(result.parsed) || replacements(parsed, result.parsed).size > 0);
            let backup, reason = quality ? 'alternative-retry-budget' : 'rendition-metadata-unavailable';
            if (quality && channel && (activeAlternative || (attempts < cfg.maxAttempts && now() >= nextTry)) && !pending) {
                if (!activeAlternative) { attempts++; nextTry = now() + cfg.retryDelay; }
                const job = startLookup(quality, epoch, usable);
                backup = await awaitResult(job, signal); reason = backup.reason || 'timeline-not-compatible';
            } else if (pending) {
                backup = await awaitResult(pending, signal);
                if (!exact(quality, backup.quality)) backup = null;
                reason = backup?.reason || 'timeline-not-compatible';
            }
            if (generation !== epoch || signal?.aborted) throw new Error('navigation-cancelled');
            if (failure) return text; // Another worker/request opened the circuit during discovery.
            if (backup?.parsed && !usable(backup)) backup = null;
            if (startup && backup?.parsed && simpleMedia(backup.parsed)) {
                if (current()) {
                    routes.set(rangeKey, { ...backup, advancedAt: now() }); delivered.set(rangeKey, true);
                    recordMedia(backup.parsed, backup.quality.url, backup.quality, 'alternative');
                                notify('BLOCKING', 'exact-quality-startup-session', { supplied: backup.parsed.segments.length, suppressed: 0, limited: false,
                        quality: { resolution: quality.resolution, fps: quality.fps, codecs: quality.codecs }, playbackVerified: false,
                                    adEvidence: parsed.segments.filter(s => s.ad).length, ambiguous: parsed.ambiguous });
                    return backup.text;
                }
                throw new DOMException('Obsolete startup request', 'AbortError');
            }
            const replacement = replacements(parsed, backup?.parsed);
            if (backup?.parsed && !replacement.size) activeAlternative = null;
            const count = parsed.segments.filter(s => s.ad).length, bypassed = replacement.size === count;
            if (current()) notify('BLOCKING', bypassed ? 'matched-content-segments-supplied' : reason,
                { limited: !bypassed, supplied: replacement.size, suppressed: count - replacement.size,
                    quality: quality && { resolution: quality.resolution, fps: quality.fps, codecs: quality.codecs },
                    playbackVerified: false, adEvidence: count, ambiguous: parsed.ambiguous });
            delivered.set(rangeKey, true);
            return rewrite(parsed, replacement);
        }
        async function filterSecondaryToken(input, init, url) {
            let endpoint; try { endpoint = new URL(url); } catch { return null; }
            if (endpoint.origin !== 'https://gql.twitch.tv' || endpoint.pathname !== '/gql' ||
                (init?.method || input?.method || 'GET').toUpperCase() !== 'POST') return null;
            let body = init?.body;
            if (body === undefined && typeof input?.clone === 'function') {
                try { body = await input.clone().text(); } catch { return null; }
            }
            if (typeof body !== 'string' || body.length > 262144) return null;
            let json; try { json = JSON.parse(body); } catch { return null; }
            const batch = Array.isArray(json), operations = batch ? json : [json];
            const blocked = operations.map(op => op?.variables?.playerType === 'picture-by-picture' &&
                (/^PlaybackAccessToken(?:_Template)?$/.test(op.operationName || '') || /\bstreamPlaybackAccessToken\s*\(/.test(op.query || '')));
            if (!blocked.some(Boolean)) return null;
            metrics.secondaryTokenBlocks += blocked.filter(Boolean).length;
            const denial = () => ({ data: { streamPlaybackAccessToken: null }, errors: [{ message: 'Secondary playback disabled', extensions: { code: 'QUALITY_GUARD_SECONDARY_DISABLED' } }] });
            const allowed = operations.filter((_, i) => !blocked[i]);
            let results = [];
            if (allowed.length) {
                const headers = new Headers(init?.headers || input?.headers); headers.delete('content-length');
                const response = await nativeFetch(input, { ...init, headers, body: JSON.stringify(batch ? allowed : allowed[0]) });
                if (!response.ok) return response;
                let result; try { result = await response.clone().json(); } catch { throw new Error('secondary-token-batch-invalid-response'); }
                results = Array.isArray(result) ? result : [result];
                if (results.length !== allowed.length) throw new Error('secondary-token-batch-invalid-response');
            }
            let cursor = 0; const merged = operations.map((_, i) => blocked[i] ? denial() : results[cursor++]);
            return new Response(JSON.stringify(batch ? merged : merged[0]), { status: 200, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
        }
        async function intercept(input, init) {
            const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
            if (String(url).startsWith('https://gql.twitch.tv/')) {
                const filtered = await filterSecondaryToken(input, init, url); if (filtered) return filtered;
            }
            // A player requesting a withheld URI did not skip it. Never synthesize
            // HTTP errors or fake media bytes in response to that capability mismatch.
            if (denied.get(url)) openCircuit('advertisement-segment-suppression');
            if (!playlistURL(url)) return nativeFetch(input, init);
            const method = init?.method || input?.method || 'GET';
            if (method !== 'GET') return nativeFetch(input, init);
            const epoch = generation, id = ++requestSerial, started = now(); metrics.playlistRequests++;
            const signal = init?.signal || input?.signal;
            let response, text, output, clock;
            const rangeKey = new URL(url).origin + new URL(url).pathname;
            const safeOriginal = () => {
                const pinned = routes.get(rangeKey);
                if (!pinned) {
                    try { recordMedia(media(text, response.url || url), url, qualityFor(url), 'original', rendition.fallbackRefreshAttempts); } catch { /* Diagnostics never change native delivery. */ }
                    return text;
                }
                const original = media(text, response.url || url);
                if (!original.hasAds && !original.unsupported && sharedAnchor(original, pinned.parsed)) {
                    routes.map.delete(rangeKey);
                    rendition.lastRecoveryAction = { action: 'rejoin-original-shared-anchor', at: now() };
                    recordMedia(original, url, qualityFor(url), 'original', pinned.refreshAttempts || 0); return text;
                }
                // A validated session is already playing. Its last playlist is a
                // bounded buffer hold, never an unsafe cross-session timeline splice.
                if (now() - pinned.advancedAt > 15000 && failure?.category !== 'player-recovery-failure') {
                    failure = { ...failure, category: 'player-recovery-failure', mode: 'hold-session', retryable: false }; lastFailure = { ...failure };
                    rendition.session = 'hold-alternative'; rendition.usingAlternative = true;
                    notify('BLOCKING', 'controlled-failure', { limited: true, playbackVerified: false });
                }
                return pinned.text;
            };
            try {
                ({ response, text, clock } = await request(input, init, signal));
                if (generation !== epoch) throw new DOMException('Channel changed', 'AbortError');
                // Re-arm only a later dated episode after verified native progression.
                // The current failed episode never retries; player faults remain latched.
                if (failure?.retryable && id >= latestCommit && recoveryBoundary !== null && !routes.map.size &&
                    now() - failure.at >= Math.max(15000, cfg.retryDelay) && !text.includes('#EXT-X-STREAM-INF:')) {
                    const next = media(text, response.url || url);
                    const nextStart = next.ranges.filter(r => next.segments.some(s => s.ad && s.time < r.end && s.time + s.duration * 1000 > r.start))
                        .reduce((v, r) => Math.min(v, r.start), Infinity);
                    if (!next.ambiguous && !next.unsupported && next.hasAds && Number.isFinite(nextStart) &&
                        nextStart >= recoveryBoundary && (failure.eventStart === null || nextStart > failure.eventStart)) {
                        failure = null; active = false; attempts = 0; nextTry = 0; pending = null;
                        sessions.clear(); mediaCache.clear(); denied.clear(); ranges.clear(); recoveryBoundary = null;
                    }
                }
                if (failure && !text.includes('#EXT-X-STREAM-INF:')) {
                    output = safeOriginal();
                    const original = media(text, response.url || url);
                    observeNotice(original, id);
                    if (!original.hasAds && !original.ambiguous && validMedia(original) && output === text && id >= latestCommit) {
                        latestCommit = id;
                        const seq = original.segments.at(-1)?.sequence ?? -1;
                        if (seq > cleanSequence) { cleanSequence = seq; cleanCount++; }
                        if (cleanCount >= 2 && Number.isFinite(noticeEvidence?.mediaEnd)) recoveryBoundary = noticeEvidence.mediaEnd;
                        notify(cleanCount >= 2 ? 'IDLE' : 'RECOVERING', cleanCount >= 2 ? 'clean-playlists-advancing' : 'clean-playlist-observed');
                    }
                } else {
                    output = await process(text, response.url || url, signal, id, clock);
                    if (failure) output = safeOriginal();
                    else if (output !== text) {
                        const checked = media(output, response.url || url);
                        if (!validMedia(checked) || checked.ambiguous || checked.segments.some(s => s.gap || s.ad) ||
                            !output.startsWith('#EXTM3U') || !/^#EXT-X-TARGETDURATION:[1-9]\d*\s*$/m.test(output)) {
                            openCircuit(['credentials-rejected', 'token-unavailable'].includes(lastReason) ? 'playback-token-failure' :
                                /timeout|network|request-failed/.test(lastReason) ? 'network-failure' :
                                lastReason === 'alternative-contains-ads-or-unknown-format' ? 'invalid-playlist-transformation' :
                                ['no-exact-quality-alternative', 'timeline-not-compatible'].includes(lastReason) ? 'fallback-unavailable' :
                                checked.segments.some(s => s.gap) ? 'advertisement-segment-suppression' : 'invalid-playlist-transformation');
                            output = safeOriginal();
                        }
                        else if (id >= latestCommit && lastReport?.state === 'BLOCKING') {
                            // Only validated player-facing output is an applied action.
                            notify('BLOCKING', lastReason, { ...lastReport, blockingApplied: true });
                        }
                    }
                }
            } catch (error) {
                const reasons = ['credentials-rejected', 'request-aborted-or-timeout', 'ad-playlist-withheld', 'startup-session-unavailable'];
                if (cfg.debug) console.debug('[TwitchAdBlock]', 'playlist-processing-error', { reason: reasons.includes(error.message) ? error.message : 'request-failed-or-cancelled' });
                if (generation !== epoch || signal?.aborted) throw error;
                if (!response) {
                    openCircuit(error.message === 'credentials-rejected' ? 'playback-token-failure' : 'network-failure');
                    // Real upstream failures remain failures; do not invent a valid
                    // playlist or start an unbounded second network retry loop.
                    throw error;
                }
                openCircuit(error.message === 'startup-session-unavailable' ? 'player-recovery-failure' :
                    error.message === 'ad-playlist-withheld' ? 'invalid-playlist-transformation' : 'network-failure');
                output = safeOriginal();
            } finally { metrics.lastPlaylistMs = now() - started; }
            const pinned = routes.get(rangeKey);
            if (pinned && output === pinned.text) {
                // A replacement response retains the original response URL. Resolve
                // fallback-relative URIs against their own playlist before delivery.
                output = output.split('\n').map(line => {
                    if (line.trim() && !line.startsWith('#')) return absolute(line.trim(), pinned.quality.url);
                    const prefix = '#EXT-X-TWITCH-PREFETCH:';
                    return line.startsWith(prefix) ? prefix + absolute(line.slice(prefix.length).trim(), pinned.quality.url) : line;
                }).join('\n');
            }
            const headers = new Headers(response.headers);
            for (const key of ['content-length', 'content-encoding', 'etag']) headers.delete(key);
            if (output !== text) { headers.set('cache-control', 'no-store'); headers.set('content-type', 'application/vnd.apple.mpegurl'); }
            const result = new Response(output, { status: response.status, statusText: response.statusText, headers });
            for (const key of ['url', 'redirected', 'type']) Object.defineProperty(result, key, { value: response[key] });
            return result;
        }
        return { attrs, master, media, exact, replacements, rewrite, process, intercept, request, reset,
            playlistURL, denied, variants, learnVariants, learnClock, Cache, openCircuit, renditionDiagnostics,
            metrics: () => ({ ...metrics }), status: () => ({ state, generation, channel, attempts, failure, lastFailure, recoveryBoundary, timingDiagnostics }) };
    }

    function workerEligible(source) {
        return typeof source === 'string' && /(?:twitch|ttvnw|Twitch)/.test(source) && /(?:WebAssembly|wasm|WASM)/.test(source);
    }
    function recoveryTarget(video, hidden) {
        if (hidden || video.paused || video.ended || video.readyState >= 3) return null;
        for (let i = 0; i < video.buffered.length; i++) {
            const start = video.buffered.start(i), end = video.buffered.end(i);
            if (start > video.currentTime && start - video.currentTime < 15 && end - start > 0.5) return start + 0.05;
        }
        return null;
    }
    // Presentation-only adapter. Engine states and failure details remain untouched.
    function createNoticeModel(ttl, now = Date.now, monotonic = now) {
        const reports = new Map(), seen = new Map();
        let event = null, channelGeneration = 0, eventSerial = 0;
        const completedEvents = new Set(), visualCompleted = new Set();
        let warning = null; const warned = new Set();
        let state = 'IDLE', cleanAt = null, progressedAfterClean = false, type = 'unknown', played = false;
        let cleanProof = null, completedThrough = -Infinity, completedAt = -Infinity;
        const active = r => (r.state === 'AD_DETECTED' || r.state === 'BLOCKING') && !r.ambiguous;
        const proof = r => r.network?.notice;
        const finite = value => typeof value === 'number' && Number.isFinite(value);
        const eventStartOf = data => {
            const p = proof(data), t = data.timing;
            // A verified complete pod owns several individual date ranges.
            if (t?.scope === 'pod' && finite(t.start) && finite(t.end) &&
                finite(p?.eventStart) && finite(p?.eventEnd) && p.eventStart >= t.start && p.eventEnd <= t.end) return t.start;
            return finite(p?.eventStart) ? p.eventStart : finite(t?.start) ? t.start : null;
        };
        const fingerprint = r => JSON.stringify(proof(r) || [r.state, r.adType, r.reason, r.timing?.start]);
        function superseded(r) {
            const p = proof(r);
            return p && finite(p.eventEnd) && ((p.eventEnd <= completedThrough) ||
                (cleanProof && finite(cleanProof.mediaStart) && finite(p.mediaEnd) &&
                    p.eventEnd <= cleanProof.mediaStart && p.mediaEnd <= cleanProof.mediaEnd));
        }
        function accepts(data, source, at) {
            const previous = seen.get(source);
            if (now() - at >= ttl || (previous && (data.generation < previous.generation || at < previous.sentAt))) return false;
            if (data.failure) return true; // Safety faults are independent of ad-event completion.
            const start = eventStartOf(data);
            if (active(data) && (completedEvents.has(start) || (event &&
                ((data.channel !== undefined && event.channel !== undefined && data.channel !== event.channel) ||
                 (finite(start) && finite(event.start) && start < event.start))))) return false;
            if (active(data) && (superseded(data) || at < completedAt)) return false;
            if (data.state === 'BLOCKING' && ((previous?.state === 'IDLE' && (!finite(start) || (proof(data) && fingerprint(data) === previous.fingerprint))) ||
                (state === 'IDLE' && Number.isFinite(completedAt) && !finite(start)))) return false;
            return true;
        }
        const acting = r => r.state === 'BLOCKING' && r.blockingApplied !== false &&
            (r.supplied > 0 || r.suppressed > 0);
        function expire() { for (const [key, r] of reports) if (monotonic() - r.freshMono >= ttl) reports.delete(key); }
        function evaluate() {
            expire();
            const live = [...reports.values()].filter(r => !superseded(r));
            if (live.some(active)) {
                const metadata = live.find(r => active(r) && ['preroll', 'midroll'].includes(r.adType))?.adType;
                if (type === 'unknown') type = metadata || (played ? 'midroll' : 'unknown');
                if (type === 'preroll') state = 'PREROLL_BLOCKING';
                else {
                    if (state === 'IDLE') state = type === 'midroll' ? 'MIDROLL_DETECTED' : 'AD_DETECTED';
                    if (live.some(acting)) state = type === 'midroll' ? 'MIDROLL_BLOCKING' : 'BLOCKING';
                }
            } else if (!live.some(r => r.state === 'RECOVERING') && cleanAt !== null && progressedAfterClean) {
                completedAt = now();
                if (finite(cleanProof?.mediaStart)) completedThrough = Math.max(completedThrough, cleanProof.mediaStart);
                if (finite(event?.start)) completedEvents.add(event.start);
                while (completedEvents.size > 128) completedEvents.delete(completedEvents.values().next().value);
                event = null; // Completion owns both the label and its timing evidence.
                state = 'IDLE'; cleanAt = null; progressedAfterClean = false; type = 'unknown'; played = true;
            }
            if (!live.length && event) { event.visualDone = true; event.visualReason ||= 'reports-expired'; }
            if (event?.clock.seconds() === 0) { event.visualDone = true; event.visualReason ||= 'countdown-expired'; }
            if (event?.visualDone && finite(event.start)) { visualCompleted.add(event.start); while (visualCompleted.size > 128) visualCompleted.delete(visualCompleted.values().next().value); }
            return state;
        }
        function visibleState() {
            evaluate();
            if (warning && now() < warning.until) return 'WARNING';
            if (!event || event.visualDone || visualCompleted.has(event.start) || !(event.clock.seconds() > 0)) return 'IDLE';
            if (state === 'MIDROLL_DETECTED' && monotonic() >= event.detectedUntil) return 'IDLE';
            if (state === 'PREROLL_BLOCKING' && !event.acting) return 'IDLE';
            return ['PREROLL_BLOCKING', 'MIDROLL_BLOCKING', 'MIDROLL_DETECTED'].includes(state) ? state : 'IDLE';
        }
        function report(data, source, reportedAt = now()) {
            evaluate();
            const previous = seen.get(source);
            if (!accepts(data, source, reportedAt)) return state;
            const signature = fingerprint(data);
            const duplicate = previous && previous.generation === data.generation && previous.fingerprint === signature;
            const freshAt = duplicate ? previous.freshAt : reportedAt;
            const freshMono = duplicate ? previous.freshMono : monotonic() - Math.max(0, now() - reportedAt);
            seen.set(source, { state: data.state, generation: data.generation, sentAt: reportedAt, freshAt, freshMono, fingerprint: signature });
            while (seen.size > 128) seen.delete(seen.keys().next().value);
            if (monotonic() - freshMono >= ttl) return evaluate();
            if (active(data) && !data.failure) {
                const start = eventStartOf(data);
                if (event && finite(start) && finite(event.end) && start >= event.end && start !== event.start && data.timing?.start === start) {
                    visualCompleted.add(event.start); event = null; type = 'unknown';
                }
                if (!event) event = { id: `${data.channel || ''}:${channelGeneration}:${++eventSerial}`,
                    channel: data.channel, channelGeneration, start, detectedUntil: monotonic() + 1000, end: data.timing?.end ?? proof(data)?.eventEnd, visualDone: false, clock: createCountdown(monotonic) };
                else if (event.start === null && finite(start)) event.start = start;
                if (acting(data)) event.acting = true;
                // Only timing for this lifecycle can modify its display. Unknown or
                // conflicting event identity cannot borrow another event's deadline.
                if ((acting(data) || (data.state === 'AD_DETECTED' && data.adType === 'midroll')) &&
                    finite(event.start) && data.timing?.start === event.start) {
                    event.clock.report({ ...data, generation: channelGeneration }, source);
                    event.end ??= data.timing.end;
                }
            }
            if (data.failure) {
                event?.clock.reset();
                const key = JSON.stringify([data.channel, data.failure.category, data.failure.eventStart ?? eventStartOf(data)]);
                if (!warned.has(key)) { warning = { until: now() + 4000, mode: data.failure.mode }; warned.add(key); }
                while (warned.size > 128) warned.delete(warned.values().next().value);
            }
            reports.set(source, { ...data, at: freshAt, freshMono });
            while (reports.size > 128) reports.delete(reports.keys().next().value);
            if (active(data) && !duplicate) { cleanAt = null; cleanProof = null; progressedAfterClean = false; }
            if (data.state === 'IDLE' && data.reason === 'clean-playlists-advancing' && cleanAt === null) {
                cleanAt = now(); cleanProof = proof(data) || null; progressedAfterClean = false;
            }
            return evaluate();
        }
        return { report, evaluate, state: () => state, visibleState, warning: () => warning,
            seconds: () => state === 'IDLE' ? null : event?.clock.seconds() ?? null,
            event: () => event ? { id: event.id, channel: event.channel, channelGeneration: event.channelGeneration,
                start: event.start, state, visualCompleted: event.visualDone, visualReason: event.visualReason || (event.clock.seconds() === null ? 'timing-unavailable' : 'timed'), remainingSeconds: event.clock.seconds() > 0 ? event.clock.seconds() : null } : null,
            clearTiming() { event?.clock.reset(); },
            accepts,
            markPlayback() { played = true; },
            engineReport: fallback => { expire(); return [...reports.values()].find(r => active(r) && !superseded(r)) || [...reports.values()].reverse().find(r => !superseded(r)) || fallback; },
            progress() { if (cleanAt !== null) progressedAfterClean = true; return evaluate(); },
            awaitingPlayback: () => cleanAt !== null && !progressedAfterClean,
            nextExpiry: () => { const dates = [...reports.values()].map(r => now() + ttl - (monotonic() - r.freshMono));
                if (event && !event.visualDone && event.clock.seconds() > 0) dates.push(now() + event.clock.seconds() * 1000);
                if (event && state === 'MIDROLL_DETECTED' && event.detectedUntil > monotonic()) dates.push(now() + event.detectedUntil - monotonic());
                if (warning && warning.until > now()) dates.push(warning.until);
                return dates.length ? Math.min(...dates) : null; },
            drop(source) { reports.delete(source); return evaluate(); },
            reset() { reports.clear(); seen.clear(); completedEvents.clear(); visualCompleted.clear(); warned.clear(); warning = null; event = null; channelGeneration++;
                cleanProof = null; completedThrough = -Infinity; completedAt = -Infinity;
                state = 'IDLE'; cleanAt = null; progressedAfterClean = false; type = 'unknown'; played = false; } };
    }
    const PLAYER_SELECTOR = '[data-a-target="video-player"], .video-player';
    const CHAT_COLUMN_SELECTOR = '.right-column, [data-a-target="right-column"], [data-test-selector="right-column"]';
    const MINI_SELECTOR = '.persistent-player--mini, [data-a-target="mini-player"], [data-test-selector="mini-player"]';
    function mainPlayer(doc) {
        // Prefer a player outside the chat/sidebar and native floating mini-player.
        return [...doc.querySelectorAll(PLAYER_SELECTOR)].find(node =>
            !node.closest(CHAT_COLUMN_SELECTOR) && !node.closest(MINI_SELECTOR) && node.querySelector('video')) || null;
    }
    function secondaryPlayers(doc, main) {
        if (!main?.querySelector('video')) return [];
        const result = new Set();
        for (const column of doc.querySelectorAll(CHAT_COLUMN_SELECTOR)) {
            for (const media of column.querySelectorAll('video')) {
                const candidate = media.closest(PLAYER_SELECTOR) || media;
                // Never hide an ancestor of the main player or the chat itself.
                if (candidate === main || candidate.contains(main) || main.contains(candidate) ||
                    !column.contains(candidate) || candidate.querySelector('[data-a-target="chat-scroller"], [role="log"]')) continue;
                result.add(candidate);
            }
        }
        for (const candidate of doc.querySelectorAll(MINI_SELECTOR)) {
            if (candidate.querySelector('video') && candidate !== main && !candidate.contains(main) && !main.contains(candidate) &&
                !candidate.querySelector('[data-a-target="chat-scroller"], [role="log"]')) result.add(candidate);
        }
        return [...result];
    }
    if (typeof module === 'object' && module.exports) { module.exports = { createCore, workerEligible, recoveryTarget, createNoticeModel, mainPlayer, secondaryPlayers, readAdTiming, createCountdown }; return; }
    if (window.__twitchQualityGuard) return;
    const log = (event, data) => { if (DEBUG) console.debug('[TwitchAdBlock]', event, data); };
    let generation = 0, route = location.pathname + location.search, video = null, root = null, badge = null;
    let hideTimer, fadeTimer, staleTimer, expiryAt = null, attachQueued = false, current = { state: 'IDLE' }, lastRecovery = 0, recoveryCount = 0;
    let paintedState = 'IDLE', paintedFailure = '', playbackTime = null;
    let safetyFailure = null;
    let countdownTimer = null, countdownNode = null, countdownPaintedAt = -Infinity;
    function stopCountdown(reset = false) {
        clearTimeout(countdownTimer); countdownTimer = null;
        if (reset) { notice.clearTiming(); countdownPaintedAt = -Infinity; }
    }
    function paintCountdown() {
        if (!badge?.isConnected || !video?.isConnected || demoNotice || !['PREROLL_BLOCKING', 'MIDROLL_BLOCKING'].includes(notice.state())) { stopCountdown(); return; }
        if (!countdownNode) return;
        const seconds = notice.seconds();
        if (seconds === 0 || notice.visibleState() === 'IDLE') {
            countdownNode.data = '';
            stopCountdown(); notice.evaluate();
            if (notice.awaitingPlayback()) playbackProgress();
            scheduleExpiry();
            render();
            return;
        }
        if (seconds === null && countdownNode.data === '...') return;
        const elapsed = performance.now() - countdownPaintedAt;
        if (elapsed < 1000) {
            if (countdownTimer === null) countdownTimer = setTimeout(() => { countdownTimer = null; paintCountdown(); }, 1000 - elapsed);
            return;
        }
        const text = seconds === null ? '...' : ` — ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
        if (countdownNode.data !== text) countdownNode.data = text;
        countdownPaintedAt = performance.now();
        if (seconds !== null && seconds > 0 && countdownTimer === null) countdownTimer = setTimeout(() => { countdownTimer = null; paintCountdown(); }, 1000);
    }
    const notice = createNoticeModel(CONFIG.statusTTL, Date.now, () => performance.timeOrigin + performance.now()), hiddenPlayers = new Set();
    const knownRenditions = new Map();
    let sharedClock = null;
    let recoveryPending = false, demoNotice = null, demoTimers = [], firstFrameAt = null, navigationAt = Date.now(), bufferingAt = null, totalBufferingMs = 0;
    let frameCallback = null, firstFrameSource = null;
    const workers = new Set(), blobs = new Map(), sourceBlobs = new WeakMap();
    function login() { return location.hostname === 'player.twitch.tv' ? new URL(location.href).searchParams.get('channel') || '' :
        /^\/([a-zA-Z0-9_]+)\/?$/.exec(location.pathname)?.[1] || ''; }
    function render() {
        const visible = demoNotice || notice, state = demoNotice ? visible.state() : visible.visibleState();
        const failureText = state === 'WARNING' ? notice.warning()?.mode === 'hold-session'
            ? '🛡 Ad blocking unavailable — playback recovery limited'
            : '🛡 Ad blocking unavailable — native playback allowed' : '';
        if (state === 'IDLE') stopCountdown(true);
        if (!badge || (state === paintedState && failureText === paintedFailure)) { paintCountdown(); return; }
        paintedFailure = failureText;
        stopCountdown(); countdownNode = null;
        const wasIdle = paintedState === 'IDLE'; paintedState = state;
        clearTimeout(hideTimer); clearTimeout(fadeTimer);
        const target = badge;
        if (state === 'IDLE') {
            hideTimer = setTimeout(() => {
                if (badge !== target || (demoNotice ? demoNotice.state() : notice.visibleState()) !== 'IDLE') return;
                target.style.opacity = '0';
                fadeTimer = setTimeout(() => {
                    if (badge !== target || (demoNotice ? demoNotice.state() : notice.visibleState()) !== 'IDLE') return;
                    target.hidden = true; target.textContent = '';
                }, 200);
            }, 0); // Do not delay early completion or countdown expiry.
            return;
        }
        target.textContent = ({ PREROLL_BLOCKING: '🛡 Preroll Blocking...', MIDROLL_DETECTED: '🛡 Ad Detected...',
            MIDROLL_BLOCKING: '🛡 Midroll Blocking...', AD_DETECTED: '🛡 Ad Detected...', BLOCKING: '🛡 Blocking ad...' })[state];
        if (failureText) target.textContent = failureText;
        if (!failureText && ['PREROLL_BLOCKING', 'MIDROLL_BLOCKING'].includes(state) && !demoNotice) {
            target.textContent = state === 'PREROLL_BLOCKING' ? '🛡 Preroll Blocking' : '🛡 Midroll Blocking';
            countdownNode = document.createTextNode('...'); target.appendChild(countdownNode); paintCountdown();
        }
        if (wasIdle) {
            target.hidden = false;
            // Establish the hidden opacity before transitioning in; do this once per episode.
            void target.offsetWidth; target.style.opacity = '1';
        }
    }
    function scheduleExpiry() {
        const next = notice.nextExpiry();
        if (next === expiryAt) return;
        clearTimeout(staleTimer); expiryAt = next;
        if (next !== null) staleTimer = setTimeout(() => {
            expiryAt = null; notice.evaluate(); render(); scheduleExpiry();
        }, Math.max(1, next - Date.now()));
    }
    function resetNotice() {
        safetyFailure = null; paintedFailure = '';
        stopCountdown(true); countdownNode = null;
        notice.reset(); for (const timer of demoTimers) clearTimeout(timer); demoTimers = []; demoNotice = null;
        clearTimeout(hideTimer); clearTimeout(fadeTimer); clearTimeout(staleTimer); expiryAt = null;
        paintedState = 'IDLE'; playbackTime = null;
        if (badge) { badge.hidden = true; badge.style.opacity = '0'; badge.textContent = ''; }
    }
    function status(data, source = 'page', reportedAt = Date.now()) {
        if (data.channel !== login()) return;
        if (!notice.accepts(data, source, reportedAt)) return;
        if (data.failure && !data.failure.retryable && (!safetyFailure || safetyFailure.retryable) && notice.accepts(data, source, reportedAt)) {
            safetyFailure = data.failure; stopCountdown(true);
            // Synchronize the circuit, not the worker's media timeline or URLs.
            for (const worker of workers) worker.postMessage({ qualityGuard: 'safety', generation, category: data.failure.category, playerFault: true });
            if (source !== 'page') core.openCircuit(data.failure.category, true);
        }
        if (!data.failure && data.lastFailure && safetyFailure?.retryable) safetyFailure = null;
        if (data.failure?.retryable && (!safetyFailure || safetyFailure.retryable)) safetyFailure = data.failure;
        if (data.failure && safetyFailure && notice.accepts(data, source, reportedAt) &&
            (data.failure.mode === 'hold-session' || ['media-decoding-failure', 'player-recovery-failure'].includes(data.failure.category))) safetyFailure = data.failure;
        if (demoNotice && (data.state === 'AD_DETECTED' || data.state === 'BLOCKING')) {
            for (const timer of demoTimers) clearTimeout(timer); demoTimers = []; demoNotice = null;
        }
        if (data.state === 'AD_DETECTED' && notice.state() === 'IDLE') { recoveryCount = 0; recoveryPending = false; }
        if (data.state === 'RECOVERING' || data.reason === 'clean-playlists-advancing') recoveryPending = true;
        const awaiting = notice.awaitingPlayback(); notice.report(data, source, reportedAt);
        current = notice.engineReport(data); // Keep the existing aggregated engine status/recovery semantics.
        if (!awaiting && notice.awaitingPlayback()) playbackTime = video?.currentTime ?? null;
        scheduleExpiry();
        log('state', data); render();
        if (recoveryPending) recover();
    }
    function shareVariants(list, clock = null, sourceWorker) {
        if (clock && (!sharedClock || clock.observedAt > sharedClock.observedAt)) sharedClock = clock;
        for (const v of list.slice(0, 128)) { knownRenditions.set(v.url, v); while (knownRenditions.size > 128) knownRenditions.delete(knownRenditions.keys().next().value); }
        for (const worker of workers) if (worker !== sourceWorker) worker.postMessage({ qualityGuard: 'variants', generation, list, clock: sharedClock });
    }
    const nativeFetch = window.fetch.bind(window), core = createCore(CONFIG, nativeFetch, status, Date.now, shareVariants, readAdTiming);
    window.__twitchQualityGuard = Object.freeze({ version: '1.1.6', status: () => ({ ...current }),
        diagnostics: () => ({ state: current.state, failure: safetyFailure, lastFailure: current.lastFailure || core.status().lastFailure,
            advertisementTiming: { ...(current.network?.timing || core.status().timingDiagnostics), event: notice.event(), remainingSeconds: notice.seconds(),
                displayEnabled: ['PREROLL_BLOCKING', 'MIDROLL_BLOCKING'].includes(notice.visibleState()) },
            notificationState: notice.visibleState(), rendition: current.network?.rendition || core.renditionDiagnostics(),
            pageRendition: core.renditionDiagnostics(), hiddenSecondaryPlayers: hiddenPlayers.size, workerCount: workers.size, actualWidth: video?.videoWidth,
            actualHeight: video?.videoHeight, selectedQuality: selectedQuality(), timeToFirstFrameMs: firstFrameAt === null ? null : firstFrameAt - navigationAt,
            firstFrameSource, bufferingMs: totalBufferingMs + (bufferingAt === null ? 0 : Date.now() - bufferingAt), recoveryAttempts: recoveryCount, reloadCount: 0, network: current.network || core.metrics() }) });
    core.reset(login()); window.fetch = core.intercept;
    function selectedQuality() {
        const checked = document.querySelector('[data-a-target="player-settings-menu"] input:checked');
        const label = checked?.closest('label')?.textContent?.trim().slice(0, 80);
        if (label) return label;
        try {
            const stored = JSON.parse(localStorage.getItem('video-quality') || 'null');
            if (typeof stored?.default === 'string') return 'stored preference: ' + stored.default.slice(0, 40);
        } catch { /* A closed settings menu and unavailable storage are not quality evidence. */ }
        return 'unavailable';
    }
    function recover() {
        if (!video || !recoveryPending || current.state === 'BLOCKING' || current.state === 'AD_DETECTED' || recoveryCount >= 1 || Date.now() - lastRecovery < 10000) return;
        const target = recoveryTarget(video, document.hidden);
        if (target === null) return;
        recoveryCount++; lastRecovery = Date.now();
        try { video.currentTime = target; } catch { core.openCircuit('player-recovery-failure'); return; }
        log('recovery', { action: 'seek-existing-buffer', actualWidth: video.videoWidth, actualHeight: video.videoHeight });
    }
    function playback() {
        if (bufferingAt !== null) { totalBufferingMs += Date.now() - bufferingAt; bufferingAt = null; }
        if (!video?.requestVideoFrameCallback && video?.videoWidth > 0 && video.readyState >= 2 && firstFrameAt === null) { firstFrameAt = Date.now(); firstFrameSource = 'media-event-estimate'; }
        log('playback', { actualWidth: video?.videoWidth, actualHeight: video?.videoHeight,
            selectedQuality: selectedQuality(), advertisedQuality: current.quality, playbackVerified: false });
    }
    function playbackProgress() {
        if (video && !video.paused && !video.seeking && video.readyState >= 2 && video.currentTime > 0 && video.videoWidth > 0) {
            if (!video.requestVideoFrameCallback && firstFrameAt === null) { firstFrameAt = Date.now(); firstFrameSource = 'media-event-estimate'; }
            if (notice.state() === 'IDLE') notice.markPlayback();
            if (bufferingAt !== null) { totalBufferingMs += Date.now() - bufferingAt; bufferingAt = null; }
        }
        if (!video || video.paused || video.ended || video.seeking || video.readyState < 2 || !notice.awaitingPlayback()) return;
        if (playbackTime === null) { playbackTime = video.currentTime; return; }
        if (video.currentTime > playbackTime + 0.1) { recoveryPending = false; notice.progress(); render(); scheduleExpiry(); }
    }
    function waiting() { if (!video?.paused && bufferingAt === null) bufferingAt = Date.now(); recover(); }
    function mediaError() {
        const category = video?.error?.code === 3 ? 'media-decoding-failure' :
            video?.error?.code === 2 ? 'network-failure' : 'player-recovery-failure';
        core.openCircuit(category, true);
    }
    function cleanSecondaryPlayers() {
        const targets = new Set(secondaryPlayers(document, root));
        for (const node of hiddenPlayers) if (!targets.has(node)) {
            node.removeAttribute('data-quality-guard-secondary'); hiddenPlayers.delete(node);
        }
        for (const node of targets) if (!hiddenPlayers.has(node)) {
            node.setAttribute('data-quality-guard-secondary', ''); hiddenPlayers.add(node);
        }
        for (const node of targets) {
            const media = node.tagName === 'VIDEO' ? [node] : [...node.querySelectorAll('video')];
            for (const item of media) if (!item.paused) item.pause();
        }
    }
    function attach() {
        attachQueued = false;
        if (route !== location.pathname + location.search) {
            route = location.pathname + location.search; generation++; resetNotice(); knownRenditions.clear(); sharedClock = null; core.reset(login()); recoveryCount = 0;
            recoveryPending = false; firstFrameAt = null; firstFrameSource = null; navigationAt = Date.now(); bufferingAt = null; totalBufferingMs = 0;
            if (frameCallback !== null) video?.cancelVideoFrameCallback?.(frameCallback); frameCallback = null;
            for (const worker of workers) worker.postMessage({ qualityGuard: 'reset', generation, channel: login() });
        }
        const nextRoot = mainPlayer(document);
        const nextVideo = nextRoot?.querySelector('video') || null;
        if (video !== nextVideo) {
            if (frameCallback !== null) video?.cancelVideoFrameCallback?.(frameCallback); frameCallback = null;
            if (video) { video.removeEventListener('error', mediaError); video.removeEventListener('waiting', waiting); video.removeEventListener('progress', recover); video.removeEventListener('playing', playback); video.removeEventListener('resize', playback); video.removeEventListener('timeupdate', playbackProgress); }
            video = nextVideo;
            if (!video) stopCountdown(true);
            playbackTime = video?.currentTime ?? null;
            if (video) { video.addEventListener('error', mediaError); video.addEventListener('waiting', waiting); video.addEventListener('progress', recover); video.addEventListener('playing', playback); video.addEventListener('resize', playback); video.addEventListener('timeupdate', playbackProgress); }
        }
        if (video?.requestVideoFrameCallback && firstFrameAt === null && frameCallback === null) {
            const watched = video, epoch = generation;
            frameCallback = video.requestVideoFrameCallback(() => {
                if (epoch !== generation || video !== watched) return;
                frameCallback = null; firstFrameAt = Date.now(); firstFrameSource = 'presented-frame';
            });
        }
        if (root !== nextRoot) {
            stopCountdown(); countdownNode = null;
            clearTimeout(hideTimer); clearTimeout(fadeTimer); badge?.remove(); root = nextRoot; badge = null; paintedState = 'IDLE';
            if (root) {
                badge = document.createElement('div'); badge.hidden = true; badge.setAttribute('data-quality-guard-notice', ''); badge.setAttribute('role', 'status'); badge.setAttribute('aria-live', 'polite');
                badge.style.cssText = 'position:absolute;top:12px;left:12px;z-index:2147483646;pointer-events:none;background:rgba(20,16,28,.88);color:white;border-left:3px solid #a970ff;border-radius:6px;padding:6px 9px;font:12.5px/1.4 system-ui,sans-serif;opacity:0;transition:opacity 200ms;max-width:75%;';
                root.appendChild(badge); render();
            }
        }
        cleanSecondaryPlayers();
    }
    function scheduleAttach() { if (!attachQueued) { attachQueued = true; queueMicrotask(attach); } }
    const observer = new MutationObserver(scheduleAttach);
    observer.observe(document, { childList: true, subtree: true });
    const secondaryStyle = document.createElement('style');
    secondaryStyle.textContent = '[data-quality-guard-secondary] { display: none !important; }';
    function installStyle() { if (!secondaryStyle.isConnected && document.documentElement) document.documentElement.appendChild(secondaryStyle); }
    installStyle(); document.addEventListener('DOMContentLoaded', installStyle, { once: true });
    window.addEventListener('popstate', scheduleAttach);
    for (const key of ['pushState', 'replaceState']) {
        const original = history[key]; history[key] = function (...args) { const result = original.apply(this, args); attach(); return result; };
    }
    document.addEventListener('visibilitychange', () => { if (!document.hidden) { attach(); recover(); } });
    function unwantedMedia(item) {
        const main = mainPlayer(document);
        return main && !main.contains(item) && secondaryPlayers(document, main).some(node => node === item || node.contains(item));
    }
    if (window.HTMLMediaElement?.prototype?.play) {
        const nativePlay = window.HTMLMediaElement.prototype.play;
        window.HTMLMediaElement.prototype.play = function (...args) {
            if (unwantedMedia(this)) { this.pause(); return Promise.reject(new DOMException('Secondary Twitch player disabled', 'NotAllowedError')); }
            return nativePlay.apply(this, args);
        };
    }
    document.addEventListener('play', event => {
        if (unwantedMedia(event.target)) { event.target.pause(); scheduleAttach(); }
    }, true);
    // This opt-in development hook drives an isolated presentation model only.
    if (DEBUG) window.testTwitchAdNotification = function (type = 'midroll') {
        if (!['preroll', 'midroll'].includes(type)) throw new Error('Use preroll or midroll');
        if (notice.state() !== 'IDLE' || demoNotice) return false;
        demoNotice = createNoticeModel(CONFIG.statusTTL);
        demoNotice.report({ state: 'AD_DETECTED', adType: type }, 'demo'); render();
        demoTimers = [setTimeout(() => { demoNotice?.report({ state: 'BLOCKING', adType: type, suppressed: 1 }, 'demo'); render(); }, 600),
            setTimeout(() => { if (!demoNotice) return; demoNotice.report({ state: 'IDLE', reason: 'clean-playlists-advancing' }, 'demo'); demoNotice.progress(); render(); }, 2200),
            setTimeout(() => { demoNotice = null; demoTimers = []; render(); }, 2600)];
        return true;
    };

    // Record only synchronously available script text. Never synchronously fetch a worker.
    const NativeBlob = window.Blob, NativeWorker = window.Worker;
    const createURL = URL.createObjectURL.bind(URL), revokeURL = URL.revokeObjectURL.bind(URL);
    window.Blob = new Proxy(NativeBlob, { construct(target, args, newTarget) {
        const blob = Reflect.construct(target, args, newTarget), parts = args[0];
        if (Array.isArray(parts) && parts.every(p => typeof p === 'string') && blob.size < 8000000) {
            const source = parts.join(''); if (workerEligible(source)) sourceBlobs.set(blob, true);
        }
        return blob;
    } });
    URL.createObjectURL = function (blob) {
        const url = createURL(blob);
        if (sourceBlobs.has(blob)) { blobs.set(url, blob); while (blobs.size > 64) blobs.delete(blobs.keys().next().value); }
        return url;
    };
    URL.revokeObjectURL = function (url) { blobs.delete(String(url)); return revokeURL(url); };
    window.Worker = new Proxy(NativeWorker, { construct(target, args) {
        const [url, options] = args;
        if (!blobs.has(String(url)) || options?.type === 'module') return Reflect.construct(target, args);
        const bridge = crypto.randomUUID(), channel = login(), epoch = generation;
        const pinnedSource = createURL(blobs.get(String(url)));
        const source = `(() => { const factory = ${createCore.toString()}; const bridge = ${JSON.stringify(bridge)};
            let epoch = ${epoch}; const engine = factory(${JSON.stringify(CONFIG)}, self.fetch.bind(self), data => self.postMessage({qualityGuard:bridge,epoch,sentAt:Date.now(),data}), Date.now,
                (list, clock) => self.postMessage({qualityGuard:bridge,epoch,variants:list,clock}), ${readAdTiming.toString()});
            engine.reset(${JSON.stringify(channel)}); self.fetch = engine.intercept;
            self.addEventListener('message', e => {
                if(e.data?.qualityGuard === 'reset') { e.stopImmediatePropagation(); epoch=e.data.generation; engine.reset(e.data.channel); }
                else if(e.data?.qualityGuard === 'variants') { e.stopImmediatePropagation(); if(e.data.generation === epoch) { engine.learnVariants(e.data.list); engine.learnClock(e.data.clock); } }
                else if(e.data?.qualityGuard === 'safety') { e.stopImmediatePropagation(); if(e.data.generation === epoch) engine.openCircuit(e.data.category, e.data.playerFault === true); }
            });
            importScripts(${JSON.stringify(pinnedSource)}); self.postMessage({qualityGuard:bridge,ready:true}); })();`;
        const bootstrap = createURL(new NativeBlob([source], { type: 'application/javascript' }));
        let worker;
        try { worker = Reflect.construct(target, [bootstrap, options]); }
        catch { revokeURL(bootstrap); revokeURL(pinnedSource); log('worker-interception-unavailable', { reason: 'constructor-rejected' }); return Reflect.construct(target, args); }
        workers.add(worker);
        if (safetyFailure && !safetyFailure.retryable) worker.postMessage({ qualityGuard: 'safety', generation, category: safetyFailure.category, playerFault: true });
        if (knownRenditions.size) worker.postMessage({ qualityGuard: 'variants', generation, list: [...knownRenditions.values()], clock: sharedClock });
        const timer = setTimeout(() => { revokeURL(bootstrap); revokeURL(pinnedSource); log('worker-handshake-timeout', { coverage: 'unverified' }); }, 5000);
        worker.addEventListener('message', event => {
            if (event.data?.qualityGuard !== bridge) return;
            event.stopImmediatePropagation();
            if (event.data.ready) { clearTimeout(timer); revokeURL(bootstrap); revokeURL(pinnedSource); log('worker-intercepted', { coverage: 'fetch-only' }); }
            else if (event.data.epoch === generation && Array.isArray(event.data.variants)) { core.learnVariants(event.data.variants); core.learnClock(event.data.clock); shareVariants(event.data.variants, event.data.clock, worker); }
            else if (event.data.epoch === generation && Number.isFinite(event.data.sentAt) && Date.now() - event.data.sentAt < CONFIG.statusTTL) status(event.data.data, bridge, event.data.sentAt);
        });
        worker.addEventListener('error', () => { clearTimeout(timer); revokeURL(bootstrap); revokeURL(pinnedSource); log('worker-failure', { coverage: 'unavailable' }); }, { once: true });
        const terminate = worker.terminate.bind(worker);
        worker.terminate = () => { clearTimeout(timer); revokeURL(bootstrap); revokeURL(pinnedSource); notice.drop(bridge); render(); scheduleExpiry(); workers.delete(worker); return terminate(); };
        return worker;
    } });
    window.addEventListener('pagehide', event => { stopCountdown(true); if (!event.persisted) { observer.disconnect(); core.reset(); resetNotice(); } });
    scheduleAttach();
})();