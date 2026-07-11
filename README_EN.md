<div align="center">

# <img src="https://www.bilibili.com/favicon.ico" width="30" height="30" style="vertical-align: text-bottom;"> [Bilibili-Live-Audio-Only](https://github.com/AHCorn/Bilibili-Live-Audio-Only)

#### [简体中文](README.md) | **English**

A userscript that blocks the video stream of Bilibili live rooms and plays audio only, reducing data usage.

> **Note:** The script UI is currently Chinese-only. The interface consists of one toggle button and a three-option settings panel, so it remains easy to use.

![JavaScript](https://img.shields.io/badge/javascript-%23323330.svg?style=for-the-badge&logo=javascript&logoColor=%23F7DF1E)
![Tampermonkey](https://img.shields.io/badge/tampermonkey-%2300485B.svg?style=for-the-badge&logo=tampermonkey&logoColor=white)
![License](https://img.shields.io/badge/license-GPL--3.0-blue?style=for-the-badge)

</div>

<br>

## Preview

<br>

<div align="center">

| Audio mode OFF | Audio mode ON |
|:---:|:---:|
| ![Normal mode](assets/player-audio-off.png) | ![Audio mode](assets/player-audio-on.png) |

*Sample: an official esports live room*

</div>

<br>

## Features

1. With audio mode enabled, the script requests a pure audio stream (AAC track only) at the stream API level. Video data never reaches the browser; the picture is not merely hidden after download.

2. The audio stream is played by Bilibili's native player. Danmaku, gifts, the popularity counter, and keyboard shortcuts keep working.

3. A floating toggle sits at the bottom-left corner of the page. Switching reloads the page automatically. Audio mode is off by default and the state lasts within the current tab only; enable "remember last state" in the settings panel for cross-session persistence.

4. The Tampermonkey script menu provides an "audio settings" panel with three options: audio mode, remember last state, and floating button injection. If you prefer the page untouched, turn off button injection and control everything from the menu.

5. In audio mode the player shows an "audio mode" indicator, distinguishing normal operation from a playback failure.

6. When toggled off, the script intercepts nothing and the page behaves as if the script were not installed.

<br>

## Usage Guide

If you are using **Google Chrome**, first install [Tampermonkey](https://chromewebstore.google.com/detail/%E7%AF%A1%E6%94%B9%E7%8C%B4/dhdgffkkebhmkfjojejmpbldmpobfkfo) from the Chrome Web Store.
If you are using **Firefox**, install the extension [here](https://addons.mozilla.org/zh-CN/firefox/addon/tampermonkey/).

After the first installation, please open the extension once. You will see a prompt asking you to:
**Enable Developer Mode** in your browser (usually found in the Extensions section of the browser menu, with a Developer Mode toggle at the top).

Then create a new script in Tampermonkey, paste the full content of `bilibili-live-audio-only.user.js`, and save. Alternatively, open the raw link of the script file in this repository; Tampermonkey will show its install page, and scripts installed this way receive updates automatically.

Open any live room. An "audio mode OFF" button appears at the bottom-left corner. Click it to switch audio mode on: the page reloads, the video area shows the "audio mode" indicator, sound plays normally, and the browser downloads audio data only. Click again to restore video playback. Audio mode is off by default and its state lasts within the current tab only.

Clicking the Tampermonkey extension icon reveals the script menu entry "音频设置" (audio settings), which opens a settings panel with the same toggle plus "remember last state" (cross-session persistence) and floating button injection options.

<br>

## Measured Data Usage

The following data was measured on 2026-07-11 as an anonymous visitor at the 250 quality tier. The stream-level method downloads both stream types directly for 30 seconds each and compares bytes; the page-level method runs a real browser for 60 seconds with the script on and off, counting all network traffic.

| Test scenario | Normal | Audio mode | Saving |
|---------------|--------|-----------|--------|
| Stream-level 30s, 720p high-motion content | 1947 kbps | 116 kbps | 94.0% |
| Stream-level 30s, official esports rebroadcast | 1392 kbps | 202 kbps | 85.5% |
| Page-level 60s, 720p high-motion content | 14.84 MB | 0.85 MB | 94.3% |
| Page-level 60s, static schedule standby screen | 1.82 MB | 1.44 MB | 20.7% |

Live video is encoded at a variable bitrate, so the saving ratio depends on on-screen motion and the quality tier. The fourth row is the extreme case: a nearly static standby screen encodes to a very low video bitrate, so the absolute saving is small. For regular live content (games, performances, matches) the saving stays above 80%. Higher quality tiers save more: one measured original-quality room ran at about 8 Mbps, corresponding to a saving above 97%.

<br>

## How It Works

Bilibili's live stream API `getRoomPlayInfo` accepts an undocumented parameter `only_audio=1`; with it, the FLV route returns a genuine audio-only stream. At the earliest stage of page load the script performs three steps:

1. Strips the server-embedded first-screen stream data, forcing the player to re-request the stream API;

2. Intercepts `XMLHttpRequest` and `fetch`, appending `only_audio=1` to stream requests;

3. Filters the returned candidate routes down to FLV only. `only_audio` takes effect on FLV only, while HLS segments still contain a video track; the filter prevents the player from picking HLS and cancelling the saving.

<br>

## FAQ

### 1. The video area stays black?

This is expected in audio mode: video data is not downloaded, and the "audio mode" indicator is shown at the center of the player. Click the bottom-left button to switch back whenever you want the picture; if the floating button is disabled, use the "音频设置" panel from the Tampermonkey menu.

If the picture does not come back after switching off, refresh the page first; if that does not help, disable this script in Tampermonkey and refresh again. If the picture recovers after disabling, the problem is related to this script — please report with the console errors. If it stays black even with the script disabled, the cause lies in the live room itself or another extension.

<br>

### 2. Why is the saving sometimes small?

Live video is encoded at a variable bitrate. When the picture is nearly static (standby schedule screens, idle chat rooms) the video bitrate is already low, so the absolute saving shrinks accordingly. With normal moving content the saving stays above 80%; see the table above.

<br>

### 3. Not working in some rooms?

Special event pages (BW venue, New Year Gala, and similar) use a standalone player that bypasses the standard stream API, so the script cannot take effect there. Standard live rooms with the regular player all work.

<br>

### 4. Does it affect danmaku, gifts, or other scripts?

No. The script modifies one parameter of the stream request and filters the returned route list; danmaku connections, gift effects, and keyboard shortcuts do not go through this path. It coexists with "Bilibili Auto Quality", though quality switching has no effect while audio mode is on since there is no video.

<br>

### 5. Could this stop working someday?

`only_audio` is an undocumented API parameter and may be removed by Bilibili. In that case the script degrades to normal playback (video plays, no saving) without breaking the room; toggling off restores fully native behavior.

<br>

### 6. Have suggestions for improvements?

Feedback is welcome. Suggestions that fit the scope of listening to live streams with less data and are practical enough will be adopted in future updates.

<br>

## ♡ Acknowledgements

The `only_audio` parameter of the stream API comes from the [bilibili-API-collect](https://github.com/SocialSisterYi/bilibili-API-collect) community documentation.
