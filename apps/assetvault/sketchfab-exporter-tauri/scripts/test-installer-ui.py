"""Verify the native bridge contract without installing or modifying Windows."""
from pathlib import Path
from playwright.sync_api import sync_playwright

with sync_playwright() as p:
    browser = p.chromium.launch(channel="chrome", headless=True)
    page = browser.new_page(viewport={"width": 1040, "height": 700})
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.add_init_script("window.__INSTALLER_NATIVE__=true; window.requests=[]; window.ipc={postMessage:value=>requests.push(JSON.parse(value))};")
    page.goto((Path(__file__).resolve().parents[1] / "installer-preview/index.html").as_uri())
    page.wait_for_function("requests.some(r=>r.action==='ready')")
    assert page.locator('#exit-installer').is_visible()
    page.locator('#exit-installer').click()
    assert page.evaluate('requests.at(-1)') == {'action':'close'}
    assert not page.locator(".demo-tools").is_visible()
    page.locator("summary").click()
    page.locator("#path").fill("D:\\模型工具\\AssetVault")
    page.locator("input[type=checkbox]").uncheck()
    page.locator("#primary").click()
    assert page.evaluate("requests.at(-1)") == {"action": "install", "path": "D:\\模型工具\\AssetVault", "shortcut": False}
    assert page.locator("#primary").is_disabled()
    assert page.locator('#exit-installer').is_disabled()
    assert '1/4' in page.locator('#stage').inner_text()
    page.evaluate("installerStatus({state:'progress',stage:'authorizing'})")
    assert '等待管理员授权' in page.locator('#stage').inner_text()
    page.evaluate("installerStatus({state:'progress',stage:'installing'})")
    assert '3/4' in page.locator('#stage').inner_text()
    assert page.locator('#fill').evaluate("el=>el.style.width") == '75%'
    assert '已用时' in page.locator('#percent').inner_text()
    assert "%" not in page.locator("#percent").inner_text()
    page.evaluate("installerStatus({state:'error',message:'测试授权取消'})")
    assert page.locator("#primary").is_enabled()
    assert page.locator(".status-note").inner_text() == "测试授权取消"
    page.locator("#primary").click()
    page.evaluate("installerStatus({state:'done',restart:true})")
    assert page.locator("#title").inner_text() == "安装完成"
    assert "重启" in page.locator(".status-note").inner_text()
    page.locator("#primary").click()
    assert page.evaluate("requests.at(-1)") == {"action": "launch"}
    assert not errors, errors
    print("PASS: ready/exit bridge, real stage reporting, elapsed time, failure/retry, completion/restart and launch")
    browser.close()

# 覆盖安装场景：__INSTALLER_EXISTING__ 命中时预填原路径，就绪态切换为更新文案
with sync_playwright() as p:
    browser = p.chromium.launch(channel="chrome", headless=True)
    page = browser.new_page(viewport={"width": 1040, "height": 700})
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.add_init_script("window.__INSTALLER_NATIVE__=true;window.__INSTALLER_EXISTING__={path:'C:\\\\Program Files\\\\AssetVault',version:'0.1.7'};window.requests=[];window.ipc={postMessage:value=>requests.push(JSON.parse(value))};")
    page.goto((Path(__file__).resolve().parents[1] / "installer-preview/index.html").as_uri())
    assert page.locator("#path").input_value() == "C:\\Program Files\\AssetVault"
    assert page.locator("#title").inner_text() == "更新 Arvimo · 艺团"
    assert "覆盖安装" in page.locator("#primary").inner_text()
    assert "将沿用原路径安装" in page.locator("#description").inner_text()
    assert not errors, errors
    print("PASS: existing installation prefill, update copy and overwrite primary button")
    browser.close()

if "--native" in __import__("sys").argv:
    import os
    import socket
    import subprocess
    import time
    import urllib.request

    root = Path(__file__).resolve().parents[1]
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    env = dict(os.environ, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=f"--remote-debugging-port={port}")
    import json
    version = json.loads((root / 'src-tauri/tauri.conf.json').read_text(encoding='utf8'))['version']
    process = subprocess.Popen([os.environ.get('ASSETVAULT_TEST_INSTALLER', str(root.parents[2] / f"dist/Arvimo_{version}_x64-setup.exe"))], env=env)
    try:
        deadline = time.monotonic() + 20
        while True:
            try:
                urllib.request.urlopen(f"http://127.0.0.1:{port}/json/version", timeout=1).close()
                break
            except OSError:
                if process.poll() is not None or time.monotonic() > deadline:
                    raise RuntimeError("Native installer did not expose its WebView")
                time.sleep(.25)
        with sync_playwright() as p:
            browser = p.chromium.connect_over_cdp(f"http://127.0.0.1:{port}")
            page = browser.contexts[0].pages[0]
            try:
                page.wait_for_selector("#primary", timeout=10000)
            except Exception:
                print("Native page:", page.url, page.content()[:600])
                raise
            assert page.evaluate("window.__INSTALLER_NATIVE__")
            import ctypes
            from ctypes import wintypes
            native_windows = []
            callback_type = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
            def inspect_window(hwnd, _):
                pid = wintypes.DWORD()
                ctypes.windll.user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
                if pid.value == process.pid and ctypes.windll.user32.IsWindowVisible(hwnd):
                    title = ctypes.create_unicode_buffer(256)
                    ctypes.windll.user32.GetWindowTextW(hwnd, title, 256)
                    if title.value == '安装 AssetVault': native_windows.append(hwnd)
                return True
            callback = callback_type(inspect_window)
            ctypes.windll.user32.EnumWindows(callback, 0)
            assert native_windows, 'Installer must become visible after ready'
            ctypes.windll.user32.GetWindowRect.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.RECT)]
            ctypes.windll.user32.ClientToScreen.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.POINT)]
            for hwnd in native_windows:
                # Tao 保留 WS_CAPTION 来获得原生阴影，通过 WM_NCCALCSIZE 去掉标题栏。
                rect, origin = wintypes.RECT(), wintypes.POINT(0, 0)
                assert ctypes.windll.user32.GetWindowRect(hwnd, ctypes.byref(rect))
                assert ctypes.windll.user32.ClientToScreen(hwnd, ctypes.byref(origin))
                assert origin.y - rect.top <= 2, f'Client content must start without a system title bar: top inset={origin.y - rect.top}'
            assert page.locator('#exit-installer').is_visible()
            page.locator("summary").click()
            page.locator("#path").fill("invalid-relative-path")
            page.locator("#primary").click()
            page.locator(".status-note").wait_for(state="visible")
            assert "有效的本地绝对路径" in page.locator(".status-note").inner_text()
            assert page.locator("#primary").is_enabled()
            page.locator("#path").fill("C:\\Program Files\\AssetVault")
            page.locator("summary").click()
            page.locator(".status-note").evaluate("el=>el.hidden=true")
            page.screenshot(path=str(root / "installer-preview/native-preview.png"))
            print("PASS: real EXE opens WebView2 and rejects invalid paths through Rust IPC; no installation performed")
            page.locator('#exit-installer').click()
            process.wait(timeout=10)
            assert process.returncode == 0
            print('PASS: native window is visible, frameless, and custom exit closes the process')
            browser.close()
    finally:
        if process.poll() is None:
            process.terminate()
        process.wait(timeout=10)
