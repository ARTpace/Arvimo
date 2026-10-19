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
    assert not page.locator(".demo-tools").is_visible()
    page.locator("summary").click()
    page.locator("#path").fill("D:\\模型工具\\AssetVault")
    page.locator("input[type=checkbox]").uncheck()
    page.locator("#primary").click()
    assert page.evaluate("requests[0]") == {"action": "install", "path": "D:\\模型工具\\AssetVault", "shortcut": False}
    assert page.locator("#primary").is_disabled()
    assert page.locator(".track").evaluate("el=>el.classList.contains('installing')")
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
    print("PASS: bridge payload, busy animation, failure/retry, completion/restart and launch")
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
    process = subprocess.Popen([str(root / f"dist/AssetVault_{version}_x64-setup.exe")], env=env)
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
            browser.close()
    finally:
        if process.poll() is None:
            process.terminate()
        process.wait(timeout=10)
