// ==UserScript==
// @name         哔哩哔哩直播音频模式
// @namespace    https://github.com/AHCorn/Bilibili-Live-Audio-Only/
// @version      1.1.0
// @license      GPL-3.0
// @description  屏蔽哔哩哔哩直播画面、只播放声音以节省流量的油猴脚本。
// @author       安和（AHCorn）
// @icon         https://www.bilibili.com/favicon.ico
// @homepageURL  https://github.com/AHCorn/Bilibili-Live-Audio-Only
// @supportURL   https://github.com/AHCorn/Bilibili-Live-Audio-Only/issues
// @match        *://live.bilibili.com/*
// @grant        GM_registerMenuCommand
// @grant        GM_getValue
// @grant        GM_setValue
// @run-at       document-start
// @updateURL    https://github.com/AHCorn/Bilibili-Live-Audio-Only/raw/main/bilibili-live-audio-only.user.js
// @downloadURL  https://github.com/AHCorn/Bilibili-Live-Audio-Only/raw/main/bilibili-live-audio-only.user.js
// ==/UserScript==

(function () {
    "use strict";

    // 带 @grant 时脚本运行在沙箱，网络钩子与内嵌数据陷阱必须落在页面真实 window 上
    var pageWindow = typeof unsafeWindow !== "undefined" ? unsafeWindow : window;

    if (pageWindow.__biliLiveAudioOnlyLoaded) return;
    pageWindow.__biliLiveAudioOnlyLoaded = true;

    // 仅直播间页面生效（含活动页 blanc 内嵌 iframe），首页/分区页的预览播放器不受影响
    var ROOM_PATH = /^\/(?:blanc\/)?\d+/;
    if (!ROOM_PATH.test(location.pathname)) return;

    var PLAY_INFO_PATH = "/xlive/web-room/v2/index/getRoomPlayInfo";

    // GM 存储跨直播间共享；无 GM 环境（@grant none）退回 localStorage
    var hasGM = typeof GM_getValue === "function" && typeof GM_setValue === "function";
    function getSetting(key, fallback) {
        try {
            if (hasGM) {
                var v = GM_getValue(key);
                return v === undefined ? fallback : v;
            }
            var raw = localStorage.getItem("bili-live-audio-only:" + key);
            return raw === null ? fallback : raw === "1";
        } catch (e) { return fallback; }
    }
    function setSetting(key, value) {
        try {
            if (hasGM) {
                GM_setValue(key, value);
            } else {
                localStorage.setItem("bili-live-audio-only:" + key, value ? "1" : "0");
            }
        } catch (e) {}
    }

    // 音频模式默认关闭；未开启"保留上次开关状态"时状态只在当前标签页内延续，
    // 开启后跨会话记忆。sessionStorage 保证按钮切换触发的刷新在本会话内生效
    var SESSION_KEY = "bili-live-audio-only:session-enabled";
    function getSessionEnabled() {
        try { return sessionStorage.getItem(SESSION_KEY) === "1"; } catch (e) { return false; }
    }
    function setSessionEnabled(on) {
        try { sessionStorage.setItem(SESSION_KEY, on ? "1" : "0"); } catch (e) {}
    }

    var rememberLast = getSetting("rememberLast", false);
    var injectButton = getSetting("injectButton", true);
    var enabled = rememberLast ? getSetting("enabled", false) : getSessionEnabled();

    function applyEnabled(on) {
        setSetting("enabled", on);
        setSessionEnabled(on);
        location.reload();
    }

    // ---------- 取流改写 ----------

    function toAbsolute(url) {
        try { return new URL(url, location.href); } catch (e) { return null; }
    }

    function isPlayInfoUrl(u) {
        return u && u.hostname === "api.live.bilibili.com" && u.pathname === PLAY_INFO_PATH;
    }

    function withOnlyAudio(u) {
        u.searchParams.set("only_audio", "1");
        return u.href;
    }

    // only_audio=1 只在 http_stream(FLV) 上真实生效，HLS 分片仍含视频轨，
    // 因此把候选流过滤到仅剩 FLV，防止播放器选中 HLS 导致白省
    function transformPlayInfo(data) {
        try {
            var playurl = data && data.data && data.data.playurl_info && data.data.playurl_info.playurl;
            if (!playurl || !playurl.stream) return data;
            var flvOnly = playurl.stream.filter(function (s) { return s.protocol_name === "http_stream"; });
            if (flvOnly.length) playurl.stream = flvOnly;
        } catch (e) {}
        return data;
    }

    function installNetworkHooks() {
        var XHR = pageWindow.XMLHttpRequest;
        var PageRequest = pageWindow.Request;
        var PageResponse = pageWindow.Response;
        var textDesc = Object.getOwnPropertyDescriptor(XHR.prototype, "responseText");
        var respDesc = Object.getOwnPropertyDescriptor(XHR.prototype, "response");

        // 用实例级惰性 getter 而非 load 监听改写响应：
        // 播放器可能在 open 前就挂好 onreadystatechange，监听器顺序不可依赖
        function hookXhrResponse(xhr) {
            var cache;
            function transformedText() {
                if (cache === undefined) {
                    var raw = textDesc.get.call(xhr);
                    try {
                        cache = JSON.stringify(transformPlayInfo(JSON.parse(raw)));
                    } catch (e) {
                        cache = raw;
                    }
                }
                return cache;
            }
            Object.defineProperty(xhr, "responseText", {
                configurable: true,
                get: function () {
                    if (xhr.readyState !== 4 || (xhr.responseType && xhr.responseType !== "text")) {
                        return textDesc.get.call(xhr);
                    }
                    return transformedText();
                }
            });
            Object.defineProperty(xhr, "response", {
                configurable: true,
                get: function () {
                    if (xhr.readyState !== 4) return respDesc.get.call(xhr);
                    if (xhr.responseType === "json") {
                        return transformPlayInfo(respDesc.get.call(xhr));
                    }
                    if (!xhr.responseType || xhr.responseType === "text") {
                        return transformedText();
                    }
                    return respDesc.get.call(xhr);
                }
            });
        }

        var hookedXhrs = new WeakSet();

        var origOpen = XHR.prototype.open;
        XHR.prototype.open = function (method, url) {
            var u = toAbsolute(url);
            if (isPlayInfoUrl(u)) {
                arguments[1] = withOnlyAudio(u);
                hookXhrResponse(this);
                hookedXhrs.add(this);
            } else if (hookedXhrs.has(this)) {
                // 实例被复用：只清掉本脚本装的实例级 getter，
                // 回落到原型访问器，避免旧缓存污染新请求
                delete this.responseText;
                delete this.response;
                hookedXhrs.delete(this);
            }
            return origOpen.apply(this, arguments);
        };

        var origFetch = pageWindow.fetch;
        pageWindow.fetch = function (input, init) {
            var url = typeof input === "string" ? input
                : (input && typeof input.href === "string") ? input.href
                : (input && input.url);
            var u = toAbsolute(url);
            if (!isPlayInfoUrl(u)) return origFetch.apply(this, arguments);

            var rewritten = withOnlyAudio(u);
            var req = (input instanceof PageRequest) ? new PageRequest(rewritten, input) : rewritten;
            return origFetch.call(this, req, init).then(function (resp) {
                return resp.clone().json().then(function (body) {
                    return new PageResponse(JSON.stringify(transformPlayInfo(body)), {
                        status: resp.status,
                        statusText: resp.statusText,
                        headers: resp.headers
                    });
                }).catch(function () { return resp; });
            });
        };
    }

    // 首屏播放数据由服务端内嵌，不走网络请求；剥掉它迫使播放器
    // 重新调用 getRoomPlayInfo，从而进入上面的改写通道
    function stripPlayInfo(v) {
        try {
            if (v && v.roomInitRes && v.roomInitRes.data && v.roomInitRes.data.playurl_info) {
                v.roomInitRes.data.playurl_info = null;
            }
        } catch (e) {}
        return v;
    }

    function installEmbeddedDataTrap() {
        // 脚本注入晚于内嵌赋值时（扩展偶发延迟），属性已存在：原地剥离，
        // 不能再挂访问器（会把已有数据换成 undefined）
        if (Object.prototype.hasOwnProperty.call(pageWindow, "__NEPTUNE_IS_MY_WAIFU__")) {
            stripPlayInfo(pageWindow.__NEPTUNE_IS_MY_WAIFU__);
            return;
        }
        var stash;
        try {
            Object.defineProperty(pageWindow, "__NEPTUNE_IS_MY_WAIFU__", {
                configurable: true,
                get: function () { return stash; },
                set: function (v) { stash = stripPlayInfo(v); }
            });
        } catch (e) {}
    }

    // 任一钩子安装失败（个别浏览器/管理器组合的安全限制）都不阻断后续 UI，
    // 用户仍能通过按钮或面板关闭音频模式
    if (enabled) {
        try { installNetworkHooks(); } catch (e) {}
        try { installEmbeddedDataTrap(); } catch (e) {}
    }

    // ---------- 播放器内状态提示 ----------

    var OVERLAY_ID = "bili-audio-only-overlay";

    // 音频模式下视频区域是纯黑，容易被当成播放故障；
    // 在播放器内挂一层不可交互的提示，随播放器重挂载自动恢复
    // 内部类名统一带 blao- 前缀（Bilibili-Live-Audio-Only），
    // 防止页面或其它脚本的全局同名样式（.bars/.slider 这类通用名）渗入
    function mountOverlay(playerEl) {
        if (document.getElementById(OVERLAY_ID)) return;
        // 未开播时播放器内没有媒体元素，别把提示叠在封面上误导
        var media = playerEl.querySelector("video, audio");
        if (!media) return;

        var overlay = document.createElement("div");
        overlay.id = OVERLAY_ID;
        overlay.innerHTML =
            '<div class="blao-bars" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></div>' +
            '<div class="blao-title">音频模式</div>' +
            '<div class="blao-sub">视频流已屏蔽，正在播放声音</div>';
        playerEl.appendChild(overlay);

        // 媒体实际带视频轨时（only_audio 失效退化、轮播播片）提示与事实不符，
        // 隐藏而非移除——移除会被常驻观察器重复补挂；播放器重建时随子树一起销毁
        function checkTrack() {
            overlay.style.display = media.videoWidth > 0 ? "none" : "";
        }
        media.addEventListener("loadedmetadata", checkTrack);
        media.addEventListener("resize", checkTrack);
        checkTrack();
    }

    function injectOverlayStyle() {
        var style = document.createElement("style");
        style.textContent = [
            "#" + OVERLAY_ID + "{position:absolute;inset:0;z-index:1;display:flex;flex-direction:column;",
            "align-items:center;justify-content:center;gap:6px;pointer-events:none;",
            "color:rgba(255,255,255,.82);font-family:-apple-system,BlinkMacSystemFont,'PingFang SC','Microsoft YaHei',sans-serif}",
            "#" + OVERLAY_ID + " .blao-bars{display:flex;align-items:flex-end;gap:3px;height:22px;margin-bottom:4px}",
            "#" + OVERLAY_ID + " .blao-bars i{width:3px;border-radius:1.5px;background:rgba(255,255,255,.65);",
            "animation:blao-bar 1.1s ease-in-out infinite}",
            "#" + OVERLAY_ID + " .blao-bars i:nth-child(1){height:8px;animation-delay:0s}",
            "#" + OVERLAY_ID + " .blao-bars i:nth-child(2){height:15px;animation-delay:.15s}",
            "#" + OVERLAY_ID + " .blao-bars i:nth-child(3){height:21px;animation-delay:.3s}",
            "#" + OVERLAY_ID + " .blao-bars i:nth-child(4){height:13px;animation-delay:.45s}",
            "#" + OVERLAY_ID + " .blao-bars i:nth-child(5){height:7px;animation-delay:.6s}",
            "@keyframes blao-bar{0%,100%{transform:scaleY(.5)}50%{transform:scaleY(1)}}",
            "@media (prefers-reduced-motion:reduce){#" + OVERLAY_ID + " .blao-bars i{animation:none}}",
            "#" + OVERLAY_ID + " .blao-title{font-size:14px;font-weight:600;letter-spacing:.5px}",
            "#" + OVERLAY_ID + " .blao-sub{font-size:12px;color:rgba(255,255,255,.45)}"
        ].join("");
        document.head.appendChild(style);
    }

    // ---------- 悬浮开关 ----------

    var BUTTON_ID = "bili-audio-only-toggle";

    function injectButtonStyle() {
        var css = [
            "#" + BUTTON_ID + "{position:fixed;left:16px;bottom:16px;z-index:100000;",
            "display:flex;align-items:center;gap:8px;padding:8px 12px;border-radius:8px;",
            "background:rgba(18,20,24,.88);border:1px solid rgba(255,255,255,.12);",
            "-webkit-backdrop-filter:blur(8px);backdrop-filter:blur(8px);",
            "box-shadow:0 1px 2px rgba(0,0,0,.3),0 4px 12px rgba(0,0,0,.25);",
            "color:#dde1e6;font:12px/1 -apple-system,BlinkMacSystemFont,'PingFang SC','Microsoft YaHei',sans-serif;",
            "cursor:pointer;user-select:none;transition:background-color .15s ease,border-color .15s ease}",
            "#" + BUTTON_ID + ":hover{background:rgba(28,31,37,.95);border-color:rgba(255,255,255,.22)}",
            "#" + BUTTON_ID + ":focus-visible{outline:2px solid rgba(120,170,255,.9);outline-offset:2px}",
            "#" + BUTTON_ID + " .blao-dot{width:6px;height:6px;border-radius:50%;background:#8a8f98}",
            "#" + BUTTON_ID + ".blao-on .blao-dot{background:#3fb960}"
        ].join("");

        var style = document.createElement("style");
        style.textContent = css;
        document.head.appendChild(style);
    }

    function mountButton() {
        if (document.getElementById(BUTTON_ID)) return;

        var btn = document.createElement("button");
        btn.id = BUTTON_ID;
        btn.type = "button";
        btn.title = "屏蔽视频流、只播音频以节省流量；点击切换后自动刷新页面";
        btn.setAttribute("aria-pressed", String(enabled));
        if (enabled) btn.classList.add("blao-on");

        var dot = document.createElement("span");
        dot.className = "blao-dot";
        var label = document.createElement("span");
        label.textContent = enabled ? "音频模式 开" : "音频模式 关";
        btn.appendChild(dot);
        btn.appendChild(label);

        btn.addEventListener("click", function () {
            applyEnabled(!enabled);
        });

        document.body.appendChild(btn);
    }

    function unmountButton() {
        var btn = document.getElementById(BUTTON_ID);
        if (btn) btn.remove();
    }

    // ---------- 设置面板（样式对齐哔哩哔哩自动画质） ----------

    var PANEL_ID = "bili-audio-settings";

    function injectPanelStyle() {
        var css = [
            "#" + PANEL_ID + "{position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);",
            "background:linear-gradient(135deg,#f6f8fa,#e9ecef);border-radius:24px;",
            "box-shadow:0 20px 50px rgba(0,0,0,0.14),0 8px 24px rgba(0,0,0,0.10);",
            "padding:30px;width:90%;max-width:440px;display:none;z-index:100001;",
            "font-family:'Segoe UI','Roboto',sans-serif;",
            "transition:all 0.3s cubic-bezier(0.25,0.8,0.25,1)}",
            "#" + PANEL_ID + ".show{display:block;animation:bili-audio-fade-in 0.3s ease-out,bili-audio-slide-in 0.3s ease-out}",
            "@keyframes bili-audio-fade-in{from{opacity:0}to{opacity:1}}",
            "@keyframes bili-audio-slide-in{from{transform:translate(-50%,-60%)}to{transform:translate(-50%,-50%)}}",
            "#" + PANEL_ID + " h2{margin:0 0 20px;color:#00a1d6;font-size:28px;text-align:center;font-weight:700}",
            "#" + PANEL_ID + " .blao-row{display:flex;align-items:center;justify-content:space-between;",
            "margin-bottom:12px;padding:10px 15px;border-radius:12px;background:#ffffff;border:1px solid #e5e7eb;",
            "box-shadow:0 1px 2px rgba(0,0,0,0.05),0 1px 1px rgba(0,0,0,0.02);",
            "transition:background-color 0.2s ease,box-shadow 0.2s ease}",
            "#" + PANEL_ID + " .blao-row:hover{background-color:#f7f9fb;",
            "box-shadow:0 3px 6px rgba(0,0,0,0.07),0 2px 4px rgba(0,0,0,0.035)}",
            "#" + PANEL_ID + " .blao-row>label:first-child{font-size:16px;color:#3c4043;font-weight:600;cursor:pointer}",
            "#" + PANEL_ID + " .blao-switch{position:relative;display:inline-block;width:52px;height:28px;flex-shrink:0}",
            "#" + PANEL_ID + " .blao-switch input{opacity:0;width:0;height:0}",
            "#" + PANEL_ID + " .blao-slider{position:absolute;cursor:pointer;inset:0;background-color:#d1d5db;",
            "transition:background-color 0.25s ease,box-shadow 0.2s ease;border-radius:999px}",
            "#" + PANEL_ID + " .blao-slider:before{position:absolute;content:'';height:22px;width:22px;left:3px;top:3px;",
            "background-color:#fff;box-shadow:0 1px 2px rgba(0,0,0,0.2),0 1px 3px rgba(0,0,0,0.08);",
            "transition:transform 0.25s cubic-bezier(0.2,0,0,1);border-radius:50%}",
            "#" + PANEL_ID + " input:checked+.blao-slider{background-color:#00a1d6}",
            "#" + PANEL_ID + " input:checked+.blao-slider:before{transform:translateX(24px)}",
            "#" + PANEL_ID + " input:focus-visible+.blao-slider{box-shadow:0 0 0 3px rgba(0,161,214,0.35)}",
            "#" + PANEL_ID + " .blao-hint{font-size:12px;color:#8a9099;line-height:1.5;margin:2px 2px 0;text-align:center}"
        ].join("");

        var style = document.createElement("style");
        style.textContent = css;
        document.head.appendChild(style);
    }

    function createPanel() {
        var panel = document.createElement("div");
        panel.id = PANEL_ID;
        panel.setAttribute("role", "dialog");
        panel.setAttribute("aria-label", "音频设置");

        var title = document.createElement("h2");
        title.textContent = "音频设置";
        panel.appendChild(title);

        panel.appendChild(makeToggleRow(PANEL_ID + "-enabled", "音频模式", enabled, function (checked) {
            applyEnabled(checked);
        }));

        panel.appendChild(makeToggleRow(PANEL_ID + "-remember", "保留上次开关状态", rememberLast, function (checked) {
            rememberLast = checked;
            setSetting("rememberLast", checked);
            // 以当前状态为"上一次"，避免开启记忆后回放更早的旧状态
            if (checked) setSetting("enabled", enabled);
        }));

        panel.appendChild(makeToggleRow(PANEL_ID + "-inject-button", "注入悬浮按钮", injectButton, function (checked) {
            injectButton = checked;
            setSetting("injectButton", checked);
            if (checked) {
                if (document.getElementById("live-player")) mountButton();
            } else {
                unmountButton();
            }
        }));

        var hint = document.createElement("div");
        hint.className = "blao-hint";
        hint.textContent = "切换音频模式后页面会自动刷新";
        panel.appendChild(hint);

        var hint2 = document.createElement("div");
        hint2.className = "blao-hint";
        hint2.textContent = "关闭悬浮按钮后可从脚本菜单打开本面板";
        panel.appendChild(hint2);

        document.body.appendChild(panel);
        return panel;
    }

    function makeToggleRow(id, labelText, checked, onChange) {
        var row = document.createElement("div");
        row.className = "blao-row";

        var label = document.createElement("label");
        label.textContent = labelText;
        label.setAttribute("for", id);

        var switchWrap = document.createElement("label");
        switchWrap.className = "blao-switch";
        var input = document.createElement("input");
        input.type = "checkbox";
        input.id = id;
        input.checked = checked;
        input.addEventListener("change", function () { onChange(input.checked); });
        var slider = document.createElement("span");
        slider.className = "blao-slider";
        switchWrap.appendChild(input);
        switchWrap.appendChild(slider);

        row.appendChild(label);
        row.appendChild(switchWrap);
        return row;
    }

    var outsideCloseHandler = null;

    function closePanel(panel) {
        panel.classList.remove("show");
        if (outsideCloseHandler) {
            document.removeEventListener("mousedown", outsideCloseHandler);
            outsideCloseHandler = null;
        }
    }

    function toggleSettingsPanel() {
        var panel = document.getElementById(PANEL_ID) || createPanel();

        // 全屏时挂到全屏根下，否则面板不可见
        var root = document.fullscreenElement || document.body;
        if (panel.parentElement !== root) root.appendChild(panel);

        if (panel.classList.contains("show")) {
            closePanel(panel);
            return;
        }
        panel.classList.add("show");

        outsideCloseHandler = function (event) {
            if (!panel.contains(event.target)) closePanel(panel);
        };
        document.addEventListener("mousedown", outsideCloseHandler);
    }

    // ---------- 装配 ----------

    function onReady(fn) {
        if (document.readyState === "loading") {
            document.addEventListener("DOMContentLoaded", fn, { once: true });
        } else {
            fn();
        }
    }

    if (typeof GM_registerMenuCommand === "function") {
        GM_registerMenuCommand("音频设置", toggleSettingsPanel);
    } else {
        // 无 GM 菜单的环境（@grant none 的管理器、测试注入）保留控制台入口
        pageWindow.__biliLiveAudioOnlySettings = toggleSettingsPanel;
    }

    // 活动特殊页（独立播放器）没有 #live-player，按钮与提示层都不该出现；
    // 观察器常驻以便播放器重建后自动补挂提示层
    onReady(function () {
        injectPanelStyle();
        injectButtonStyle();
        if (enabled) injectOverlayStyle();

        function sync() {
            var playerEl = document.getElementById("live-player");
            if (!playerEl) return;
            if (injectButton) mountButton();
            if (enabled) mountOverlay(playerEl);
        }

        new MutationObserver(sync).observe(document.body, { childList: true, subtree: true });
        sync();
    });
})();
