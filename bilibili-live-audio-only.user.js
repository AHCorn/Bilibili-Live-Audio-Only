// ==UserScript==
// @name         哔哩哔哩直播音频模式
// @namespace    https://github.com/AHCorn/Bilibili-Live-Audio-Only/
// @version      1.2.0
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
    var origPageFetch = pageWindow.fetch.bind(pageWindow);

    if (pageWindow.__biliLiveAudioOnlyLoaded) return;
    pageWindow.__biliLiveAudioOnlyLoaded = true;

    // 仅直播间页面生效（含活动页 blanc 内嵌 iframe），首页/分区页的预览播放器不受影响
    var ROOM_PATH = /^\/(?:blanc\/)?\d+/;
    if (!ROOM_PATH.test(location.pathname)) return;

    var PLAY_INFO_PATH = "/xlive/web-room/v2/index/getRoomPlayInfo";
    var APP_PLAYURL = "https://api.live.bilibili.com/xlive/app-room/v1/playUrl/playUrl";
    var STORAGE_PREFIX = "bili-live-audio-only:";

    // GM 存储跨直播间共享；无 GM 环境（@grant none）退回 localStorage
    var hasGM = typeof GM_getValue === "function" && typeof GM_setValue === "function";
    function getStored(key, fallback) {
        try {
            if (hasGM) {
                var v = GM_getValue(key);
                return v === undefined ? fallback : v;
            }
            var raw = localStorage.getItem(STORAGE_PREFIX + key);
            return raw === null ? fallback : raw;
        } catch (e) { return fallback; }
    }
    function setStored(key, value) {
        try {
            if (hasGM) {
                GM_setValue(key, value);
            } else {
                localStorage.setItem(STORAGE_PREFIX + key, String(value));
            }
        } catch (e) {}
    }
    function getSetting(key, fallback) {
        var v = getStored(key, fallback);
        if (typeof v === "boolean") return v;
        if (v === "1" || v === 1) return true;
        if (v === "0" || v === 0) return false;
        return fallback;
    }
    function setSetting(key, value) {
        if (hasGM) setStored(key, value);
        else setStored(key, value ? "1" : "0");
    }
    function getStreamMode() {
        var mode = getStored("streamMode", "web");
        return mode === "app" ? "app" : "web";
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
    var streamMode = getStreamMode();
    var enabled = rememberLast ? getSetting("enabled", false) : getSessionEnabled();

    var SCRIPT_VERSION = "1.2.1";
    var LOG_PREFIX = "[音频模式]";
    var debugEvents = [];
    var DEBUG_LIMIT = 40;

    function hostPath(url) {
        try {
            var u = new URL(url, location.href);
            return u.host + u.pathname;
        } catch (e) { return "(url)"; }
    }

    function logDebug(msg, extra) {
        var line = { t: Date.now(), msg: msg };
        if (extra !== undefined) line.extra = extra;
        debugEvents.push(line);
        if (debugEvents.length > DEBUG_LIMIT) debugEvents.shift();
        try {
            if (extra !== undefined) pageWindow.console.log(LOG_PREFIX, msg, extra);
            else pageWindow.console.log(LOG_PREFIX, msg);
        } catch (e) {}
    }

    function snapshotMedia() {
        var media = document.querySelector("#live-player video, #live-player audio");
        if (!media) return null;
        return {
            ct: Math.round(media.currentTime * 10) / 10,
            videoWidth: media.videoWidth,
            readyState: media.readyState,
            paused: media.paused
        };
    }

    function snapshotPlayerError() {
        var player = document.getElementById("live-player");
        if (!player) return "";
        var nodes = player.querySelectorAll("div");
        for (var i = 0; i < nodes.length; i++) {
            var text = (nodes[i].textContent || "").replace(/\s+/g, " ").trim();
            if (text.length > 180) continue;
            if (/直播播放异常/.test(text) || /status:\s*9\d{4}/.test(text)) return text;
        }
        return "";
    }

    function collectDebugDump() {
        var lines = [
            "哔哩哔哩直播音频模式 " + SCRIPT_VERSION,
            "url: " + location.href,
            "enabled: " + enabled,
            "streamMode: " + streamMode,
            "rememberLast: " + rememberLast,
            "injectButton: " + injectButton,
            "hasGM: " + hasGM,
            "player: " + (document.getElementById("live-player") ? "yes" : "no"),
            "media: " + JSON.stringify(snapshotMedia()),
            "playerError: " + (snapshotPlayerError() || "none"),
            "events:"
        ];
        for (var i = 0; i < debugEvents.length; i++) {
            var ev = debugEvents[i];
            var extra = ev.extra !== undefined ? " " + JSON.stringify(ev.extra) : "";
            lines.push("  " + new Date(ev.t).toISOString() + " " + ev.msg + extra);
        }
        return lines.join("\n");
    }

    pageWindow.__biliLiveAudioOnlyDebug = collectDebugDump;

    logDebug("启动", {
        version: SCRIPT_VERSION,
        enabled: enabled,
        streamMode: streamMode,
        rememberLast: rememberLast,
        injectButton: injectButton,
        hasGM: hasGM,
        path: location.pathname
    });

    function applyEnabled(on) {
        logDebug("切换音频模式", { from: enabled, to: on });
        setSetting("enabled", on);
        setSessionEnabled(on);
        location.reload();
    }

    function applyStreamMode(mode) {
        var next = mode === "app" ? "app" : "web";
        logDebug("切换取流接口", { from: streamMode, to: next, willReload: enabled });
        streamMode = next;
        setStored("streamMode", streamMode);
        // 取流钩子在 document-start 装好，改模式必须刷新才生效
        if (enabled) location.reload();
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

    function toHttps(url) {
        return url.indexOf("http://") === 0 ? "https://" + url.slice(7) : url;
    }

    // only_audio=1 只在 http_stream(FLV) 上真实生效，HLS 分片仍含视频轨，
    // 因此把候选流过滤到仅剩 FLV，防止播放器选中 HLS 导致白省
    function filterFlvOnly(data) {
        try {
            var playurl = data && data.data && data.data.playurl_info && data.data.playurl_info.playurl;
            if (!playurl || !playurl.stream) return data;
            var flvOnly = playurl.stream.filter(function (s) { return s.protocol_name === "http_stream"; });
            if (flvOnly.length) playurl.stream = flvOnly;
        } catch (e) {}
        return data;
    }

    function transformPlayInfo(data) {
        return filterFlvOnly(data);
    }

    // App 端 playUrl 的 durl 本身就是纯 AAC；按 host+base_url+extra 拼进网页播放器的 FLV 槽
    function injectAppUrls(data, appUrls) {
        try {
            var playurl = data && data.data && data.data.playurl_info && data.data.playurl_info.playurl;
            if (!playurl || !playurl.stream || !appUrls.length) return data;

            var urlInfos = [];
            for (var i = 0; i < appUrls.length; i++) {
                var parsed = new URL(appUrls[i], location.href);
                urlInfos.push({
                    host: parsed.origin + parsed.pathname,
                    extra: parsed.search.charAt(0) === "?" ? parsed.search.slice(1) : parsed.search,
                    stream_ttl: 0
                });
            }

            var flv = playurl.stream.filter(function (s) { return s.protocol_name === "http_stream"; });
            if (!flv.length && playurl.stream.length) {
                var proto = JSON.parse(JSON.stringify(playurl.stream[0]));
                proto.protocol_name = "http_stream";
                proto.format = proto.format && proto.format.length ? [proto.format[0]] : [];
                if (proto.format[0]) proto.format[0].format_name = "flv";
                flv = [proto];
            }
            for (var s = 0; s < flv.length; s++) {
                var formats = (flv[s].format || []).filter(function (f) { return f.format_name === "flv"; });
                if (!formats.length && flv[s].format && flv[s].format.length) {
                    flv[s].format[0].format_name = "flv";
                    formats = [flv[s].format[0]];
                }
                flv[s].format = formats;
                for (var f = 0; f < formats.length; f++) {
                    var codecs = formats[f].codec || [];
                    for (var c = 0; c < codecs.length; c++) {
                        codecs[c].base_url = "?";
                        codecs[c].url_info = urlInfos;
                    }
                }
            }
            if (flv.length) playurl.stream = flv;
        } catch (e) {}
        return data;
    }

    function collectAppDurl(durl) {
        var urls = [];
        if (!durl) return urls;
        for (var i = 0; i < durl.length; i++) {
            if (durl[i].url) urls.push(toHttps(durl[i].url));
            var backs = durl[i].backup_url || [];
            for (var j = 0; j < backs.length; j++) urls.push(toHttps(backs[j]));
        }
        // 裸 IP CDN 常 403，把域名线路排到前面给播放器先试
        urls.sort(function (a, b) {
            function score(u) {
                return /bilivideo\.com|gotcha|bytefcdn/i.test(u) ? 0 : 1;
            }
            return score(a) - score(b);
        });
        return urls;
    }

    function summarizePlayInfo(data) {
        try {
            var d = data && data.data;
            var streams = d && d.playurl_info && d.playurl_info.playurl && d.playurl_info.playurl.stream;
            var names = [];
            if (streams) {
                for (var i = 0; i < streams.length; i++) names.push(streams[i].protocol_name);
            }
            return {
                code: data && data.code,
                live_status: d && d.live_status,
                room_id: d && d.room_id,
                streams: names
            };
        } catch (e) {
            return { error: "summarize" };
        }
    }

    function fetchAppAudioUrls(roomId) {
        if (!roomId) return Promise.reject(new Error("no room id"));
        var url = APP_PLAYURL
            + "?cid=" + encodeURIComponent(roomId)
            + "&device=android&https_url_req=1&mobi_app=android&network=wifi"
            + "&platform=android&play_type=0&ptype=1&quality=4";
        logDebug("请求 App playUrl", { roomId: roomId });
        return origPageFetch(url, { credentials: "include" }).then(function (resp) {
            return resp.json();
        }).then(function (body) {
            var urls = collectAppDurl(body && body.data && body.data.durl);
            var hosts = [];
            for (var i = 0; i < urls.length; i++) hosts.push(hostPath(urls[i]));
            logDebug("playUrl 返回", {
                roomId: roomId,
                code: body && body.code,
                message: body && body.message,
                count: urls.length,
                hosts: hosts
            });
            if (!urls.length) throw new Error("empty app durl code=" + (body && body.code));
            return urls;
        });
    }

    function loadAppModePlayInfo(playInfoHref) {
        logDebug("拦截 getRoomPlayInfo", { mode: "app", url: hostPath(playInfoHref) });
        return origPageFetch(playInfoHref, { credentials: "include" }).then(function (resp) {
            return resp.json();
        }).then(function (body) {
            var roomId = body && body.data && body.data.room_id;
            logDebug("getRoomPlayInfo 骨架", summarizePlayInfo(body));
            return fetchAppAudioUrls(roomId).then(function (urls) {
                var rewritten = injectAppUrls(body, urls);
                logDebug("已注入 App 音频地址", summarizePlayInfo(rewritten));
                return rewritten;
            });
        });
    }

    function loadWebModePlayInfo(playInfoHref) {
        var u = toAbsolute(playInfoHref);
        logDebug("请求网页 only_audio", { url: hostPath(playInfoHref) });
        return origPageFetch(withOnlyAudio(u), { credentials: "include" }).then(function (resp) {
            return resp.json();
        }).then(function (body) {
            var rewritten = transformPlayInfo(body);
            logDebug("网页接口改写完成", summarizePlayInfo(rewritten));
            return rewritten;
        });
    }

    function completeXhrWithJson(xhr, data) {
        var text = JSON.stringify(data);
        Object.defineProperty(xhr, "readyState", { configurable: true, get: function () { return 4; } });
        Object.defineProperty(xhr, "status", { configurable: true, get: function () { return 200; } });
        Object.defineProperty(xhr, "statusText", { configurable: true, get: function () { return "OK"; } });
        Object.defineProperty(xhr, "responseText", { configurable: true, get: function () { return text; } });
        Object.defineProperty(xhr, "response", {
            configurable: true,
            get: function () {
                return xhr.responseType === "json" ? data : text;
            }
        });
        xhr.getAllResponseHeaders = function () { return "content-type: application/json\r\n"; };
        xhr.getResponseHeader = function (name) {
            return String(name).toLowerCase() === "content-type" ? "application/json" : null;
        };

        function fire(type, handler) {
            var ev = new pageWindow.Event(type);
            if (typeof handler === "function") handler.call(xhr, ev);
            xhr.dispatchEvent(ev);
        }
        if (typeof xhr.onreadystatechange === "function") xhr.onreadystatechange();
        fire("readystatechange", null);
        fire("load", xhr.onload);
        fire("loadend", xhr.onloadend);
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
                        var data = transformPlayInfo(JSON.parse(raw));
                        cache = JSON.stringify(data);
                        logDebug("XHR 网页接口改写完成", summarizePlayInfo(data));
                    } catch (e) {
                        cache = raw;
                        logDebug("XHR 响应改写失败", String(e && e.message || e));
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

        function wrapXhrSendForApp(xhr, playInfoUrl) {
            xhr.send = function () {
                loadAppModePlayInfo(playInfoUrl.href).catch(function (err) {
                    logDebug("App 接口失败，回退网页接口", String(err && err.message || err));
                    return loadWebModePlayInfo(playInfoUrl.href);
                }).then(function (data) {
                    completeXhrWithJson(xhr, data);
                }).catch(function (err) {
                    logDebug("改写失败，放行原始取流", String(err && err.message || err));
                    hookXhrResponse(xhr);
                    XHR.prototype.send.call(xhr);
                });
            };
        }

        var hookedXhrs = new WeakSet();

        var origOpen = XHR.prototype.open;
        XHR.prototype.open = function (method, url) {
            var u = toAbsolute(url);
            if (isPlayInfoUrl(u)) {
                if (streamMode === "app") {
                    logDebug("XHR 走 App 改写", { url: hostPath(u.href) });
                    wrapXhrSendForApp(this, u);
                } else {
                    logDebug("XHR 追加 only_audio", { url: hostPath(u.href) });
                    arguments[1] = withOnlyAudio(u);
                    hookXhrResponse(this);
                }
                hookedXhrs.add(this);
            } else if (hookedXhrs.has(this)) {
                // 实例被复用：只清掉本脚本装的实例级 getter，
                // 回落到原型访问器，避免旧缓存污染新请求
                delete this.responseText;
                delete this.response;
                delete this.readyState;
                delete this.status;
                delete this.statusText;
                hookedXhrs.delete(this);
            }
            return origOpen.apply(this, arguments);
        };

        pageWindow.fetch = function (input, init) {
            var url = typeof input === "string" ? input
                : (input && typeof input.href === "string") ? input.href
                : (input && input.url);
            var u = toAbsolute(url);
            if (!isPlayInfoUrl(u)) return origPageFetch.call(this, input, init);

            if (streamMode === "app") {
                logDebug("fetch 走 App 改写", { url: hostPath(u.href) });
                return loadAppModePlayInfo(u.href).catch(function (err) {
                    logDebug("App 接口失败，回退网页接口", String(err && err.message || err));
                    return loadWebModePlayInfo(u.href);
                }).then(function (body) {
                    return new PageResponse(JSON.stringify(body), {
                        status: 200,
                        headers: { "Content-Type": "application/json" }
                    });
                });
            }

            logDebug("fetch 追加 only_audio", { url: hostPath(u.href) });
            var rewritten = withOnlyAudio(u);
            var req = (input instanceof PageRequest) ? new PageRequest(rewritten, input) : rewritten;
            return origPageFetch.call(this, req, init).then(function (resp) {
                return resp.clone().json().then(function (body) {
                    var rewrittenBody = transformPlayInfo(body);
                    logDebug("fetch 网页接口改写完成", summarizePlayInfo(rewrittenBody));
                    return new PageResponse(JSON.stringify(rewrittenBody), {
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
    var strippedOnce = false;
    function stripPlayInfo(v) {
        try {
            var had = !!(v && v.roomInitRes && v.roomInitRes.data && v.roomInitRes.data.playurl_info);
            if (had) v.roomInitRes.data.playurl_info = null;
            if (!strippedOnce) {
                strippedOnce = true;
                logDebug("剥离内嵌取流", { had: had });
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
        try { installNetworkHooks(); logDebug("网络钩子已安装", { streamMode: streamMode }); } catch (e) {
            logDebug("网络钩子安装失败", String(e && e.message || e));
        }
        try { installEmbeddedDataTrap(); } catch (e) {
            logDebug("内嵌数据陷阱安装失败", String(e && e.message || e));
        }
    } else {
        logDebug("音频模式关闭，不拦截取流");
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
            '<div class="blao-sub">视频流已屏蔽，正在播放声音' +
            (streamMode === "app" ? " · App 接口" : "") + "</div>";
        playerEl.appendChild(overlay);

        // 媒体实际带视频轨时（only_audio 失效退化、轮播播片）提示与事实不符，
        // 隐藏而非移除——移除会被常驻观察器重复补挂；播放器重建时随子树一起销毁
        var loggedTrack = false;
        function checkTrack() {
            if (!loggedTrack && media.readyState >= 1) {
                loggedTrack = true;
                logDebug("媒体轨", snapshotMedia());
            }
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
            "#" + OVERLAY_ID + " .blao-sub{font-size:12px;color:rgba(255,255,255,.45)}",
            // 音频流无视频轨时播放器会打出 92002/90002 异常层，盖住提示也像故障
            "#live-player .web-player-ending-panel,",
            "#live-player .web-player-error-panel,",
            "#live-player .player-ending-panel{display:none!important}"
        ].join("");
        document.head.appendChild(style);
    }

    var errorScanPlayer = null;
    var errorHidden = false;

    function hidePlayerError(playerEl) {
        if (errorScanPlayer !== playerEl) {
            errorScanPlayer = playerEl;
            errorHidden = false;
        }
        if (errorHidden) return;
        var known = playerEl.querySelector(".web-player-ending-panel, .web-player-error-panel, .player-ending-panel");
        if (known) {
            known.style.setProperty("display", "none", "important");
            errorHidden = true;
            logDebug("隐藏播放器异常层", { via: "class", text: snapshotPlayerError() || known.className });
            return;
        }
        var nodes = playerEl.querySelectorAll("div");
        for (var i = 0; i < nodes.length; i++) {
            var el = nodes[i];
            if (el.id === OVERLAY_ID || el.id === "live-player") continue;
            if (document.getElementById(OVERLAY_ID) && el.contains(document.getElementById(OVERLAY_ID))) continue;
            var text = el.textContent || "";
            if (!/直播播放异常/.test(text) && !/status:\s*9\d{4}/.test(text)) continue;
            if (el.childElementCount > 20) continue;
            el.style.setProperty("display", "none", "important");
            errorHidden = true;
            logDebug("隐藏播放器异常层", { via: "text", text: (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 160) });
            return;
        }
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
            "#" + PANEL_ID + " .blao-row-mode{flex-direction:column;align-items:stretch;gap:10px}",
            "#" + PANEL_ID + " .blao-row-mode>label:first-child{cursor:default}",
            "#" + PANEL_ID + " .blao-seg{position:relative;display:grid;grid-template-columns:1fr 1fr;",
            "background:#eef1f4;border:0;border-radius:10px;padding:3px;overflow:hidden}",
            "#" + PANEL_ID + " .blao-seg-thumb{position:absolute;top:3px;bottom:3px;left:3px;width:calc(50% - 3px);",
            "background:#00a1d6;border-radius:8px;pointer-events:none;",
            "transition:transform .22s cubic-bezier(0.2,0,0,1)}",
            "#" + PANEL_ID + " .blao-seg[data-mode='app'] .blao-seg-thumb{transform:translateX(100%)}",
            "#" + PANEL_ID + " .blao-seg button{appearance:none;-webkit-appearance:none;position:relative;z-index:1;",
            "border:0;margin:0;background:transparent;color:#5f6368;",
            "font:13px/1.2 'Segoe UI','Roboto',sans-serif;font-weight:600;padding:8px 0;cursor:pointer}",
            "#" + PANEL_ID + " .blao-seg button[aria-checked='true']{background:transparent;color:#fff}",
            "#" + PANEL_ID + " .blao-seg button:hover:not([aria-checked='true']){color:#3c4043}",
            "#" + PANEL_ID + " .blao-seg button:focus-visible{outline:2px solid rgba(0,161,214,0.45);outline-offset:-2px}",
            "@media (prefers-reduced-motion:reduce){#" + PANEL_ID + " .blao-seg-thumb{transition:none}}",
            "#" + PANEL_ID + " .blao-hint{font-size:12px;color:#8a9099;line-height:1.5;margin:2px 2px 0;text-align:center}",
            "#" + PANEL_ID + " .blao-copy-debug{display:block;margin:10px auto 0;padding:0;border:0;background:none;",
            "color:#00a1d6;font:12px/1.5 'Segoe UI','Roboto',sans-serif;font-weight:600;cursor:pointer}",
            "#" + PANEL_ID + " .blao-copy-debug:hover{color:#0084b0}",
            "#" + PANEL_ID + " .blao-copy-debug:focus-visible{outline:2px solid rgba(0,161,214,0.45);outline-offset:2px}"
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

        panel.appendChild(makeModeRow());

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
        hint.textContent = "切换音频模式或取流接口后页面会自动刷新";
        panel.appendChild(hint);

        var hint2 = document.createElement("div");
        hint2.className = "blao-hint";
        hint2.textContent = "网页接口异常时可改用 App 接口；关闭悬浮按钮后从脚本菜单打开本面板";
        panel.appendChild(hint2);

        var copyBtn = document.createElement("button");
        copyBtn.type = "button";
        copyBtn.className = "blao-copy-debug";
        copyBtn.textContent = "复制调试信息";
        copyBtn.addEventListener("click", function () {
            copyDebugInfo(copyBtn);
        });
        panel.appendChild(copyBtn);

        document.body.appendChild(panel);
        return panel;
    }

    function copyDebugInfo(btn) {
        var text = collectDebugDump();
        function done(ok) {
            btn.textContent = ok ? "已复制，可粘贴到反馈里" : "复制失败，请打开控制台查看";
            setTimeout(function () { btn.textContent = "复制调试信息"; }, 1800);
        }
        function fallback() {
            try {
                var ta = document.createElement("textarea");
                ta.value = text;
                ta.setAttribute("readonly", "");
                ta.style.cssText = "position:fixed;left:-9999px;top:0";
                document.body.appendChild(ta);
                ta.select();
                var ok = document.execCommand("copy");
                ta.remove();
                done(ok);
            } catch (e) {
                done(false);
            }
        }
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).then(function () { done(true); }).catch(fallback);
        } else {
            fallback();
        }
    }

    function makeModeRow() {
        var row = document.createElement("div");
        row.className = "blao-row blao-row-mode";

        var label = document.createElement("label");
        label.id = PANEL_ID + "-mode-label";
        label.textContent = "取流接口";

        var group = document.createElement("div");
        group.className = "blao-seg";
        group.setAttribute("role", "radiogroup");
        group.setAttribute("aria-labelledby", label.id);
        group.setAttribute("data-mode", streamMode);

        var thumb = document.createElement("span");
        thumb.className = "blao-seg-thumb";
        thumb.setAttribute("aria-hidden", "true");
        group.appendChild(thumb);

        function selectMode(mode, persist) {
            group.setAttribute("data-mode", mode);
            var buttons = group.querySelectorAll("[role='radio']");
            for (var i = 0; i < buttons.length; i++) {
                buttons[i].setAttribute("aria-checked", String(buttons[i].id === PANEL_ID + "-mode-" + mode));
            }
            if (persist && streamMode !== mode) applyStreamMode(mode);
        }

        function makeOption(mode, text) {
            var btn = document.createElement("button");
            btn.type = "button";
            btn.id = PANEL_ID + "-mode-" + mode;
            btn.setAttribute("role", "radio");
            btn.setAttribute("aria-checked", String(streamMode === mode));
            btn.textContent = text;
            btn.addEventListener("click", function () {
                if (streamMode === mode) return;
                selectMode(mode, true);
            });
            return btn;
        }

        group.appendChild(makeOption("web", "网页接口"));
        group.appendChild(makeOption("app", "App 接口"));
        group.addEventListener("keydown", function (event) {
            if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
            event.preventDefault();
            selectMode(event.key === "ArrowRight" ? "app" : "web", true);
        });
        row.appendChild(label);
        row.appendChild(group);
        return row;
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
            if (enabled) {
                mountOverlay(playerEl);
                hidePlayerError(playerEl);
            }
        }

        new MutationObserver(sync).observe(document.body, { childList: true, subtree: true });
        sync();
    });
})();
