# Twitch Guard

**Version 1.1.6 Beta** · A lightweight, standalone Twitch userscript focused on reducing preroll and midroll ads while protecting stream quality and playback stability.

> **Beta software:** Ad blocking is best-effort, not guaranteed. v1.1.6 passed focused automated tests but has **not yet been verified on live Twitch**.

## Features

- **Preroll and midroll handling:** Detects supported Twitch HLS ad markers and attempts to find clean playback alternatives.
- **Quality preservation:** Matches the selected stream's resolution, frame rate, and codecs. Supports nonstandard renditions such as **810p50** when a compatible alternative exists; never deliberately downgrades quality.
- **Playback protection:** Bounded fallback retries, stalled-playlist recovery, and conservative native playback when a safe replacement cannot be found.
- **Unobtrusive notifications:** A small countdown appears only when ad timing can be established reliably; it disappears when the event ends or the timer expires.
- **Secondary-player suppression:** Attempts to prevent Twitch's Picture-by-Picture ad player above chat.

No account setup, external service, or additional application is required beyond a userscript manager.

## Installation

1. Install [Tampermonkey](https://www.tampermonkey.net/) for your browser.
2. **Chrome 138+ / supported Chromium browsers:** Open your browser's Extensions page, select **Tampermonkey → Details**, and turn on **Allow User Scripts**. On older Chrome versions, enable **Developer mode** on the Extensions page instead. See [Tampermonkey's official instructions](https://www.tampermonkey.net/faq.php#Q209).
3. **[Install Twitch Guard v1.1.6](https://raw.githubusercontent.com/Nyxia-Code/Twitch-Quality-Guard/main/twitch-ad-block.user.js)** using Tampermonkey, then approve the installation. Alternatively, open the [userscript source](./twitch-ad-block.user.js) and import it into Tampermonkey.
4. Ensure **only one copy** of Twitch Guard is enabled. Disable other Twitch playback/ad-interception userscripts while testing to avoid conflicts.
5. Refresh your Twitch tab. Select a fixed quality in Twitch's video settings if you want to avoid Twitch's own **Auto** quality changes.

**Updates:** The GitHub-configured userscript includes Tampermonkey update URLs. Updates can be detected when a newer `@version` is published to this repository; your manager's update settings control when checks run.

## Current status

**v1.1.6** improves recovery from frozen alternative playlists, checks multiple exact-quality fallback candidates, and avoids unnecessary safety failures when you manually change quality. It also adds privacy-conscious playback diagnostics.

- **21/21 focused regression tests passed**, plus JavaScript syntax validation.
- The earlier **143-test project suite was not rerun** for this build.
- Live playback at **810p50**—the resolution that exposed repeated buffering—still needs retesting.

## Troubleshooting and limitations

If a stream buffers, try another quality temporarily, then compare playback with Twitch Guard disabled. You can inspect diagnostics with **F12 → Console**:

```js
window.__twitchQualityGuard?.diagnostics()
```

The script cannot guarantee ad-free or uninterrupted playback. If Twitch does not provide a safe, exact-quality alternative, **native playback may show ads**; a stalled alternative may still require a refresh. Twitch may change its player, playlist formats, or permissions at any time. Browser and userscript-manager compatibility also varies.

Please avoid posting full playlist URLs, playback tokens, or authentication data in bug reports.

---

**Independent community project. Not affiliated with or endorsed by Twitch.**
