"""Smoke-test the compiled desktop shell and its bundled local service."""
import os
import subprocess
import time
import json
import ctypes
from ctypes import wintypes
from pathlib import Path
from urllib.parse import urlsplit
from playwright.sync_api import sync_playwright

root = Path(__file__).resolve().parents[1]
env = dict(os.environ, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS='--remote-debugging-port=49281')
executable = os.environ.get('ASSETVAULT_TEST_DESKTOP', str(root / 'src-tauri/target/release/assetvault.exe'))
proc = subprocess.Popen([executable], env=env)
try:
    with sync_playwright() as p:
        deadline = time.monotonic() + 25
        while True:
            try:
                browser = p.chromium.connect_over_cdp('http://127.0.0.1:49281', timeout=2000)
                break
            except Exception:
                if time.monotonic() > deadline:
                    raise
                time.sleep(.5)
        page = browser.contexts[0].pages[0]
        page.wait_for_url('http://127.0.0.1:*/**', timeout=40000)
        origin = urlsplit(page.url)
        health = page.request.get(f'{origin.scheme}://{origin.netloc}/api/health')
        assert health.ok and health.json()['name'] == 'assetvault-local-library'
        page.wait_for_selector('#settings-button', timeout=30000)
        print('PASS: compiled desktop shell starts bundled service and opens library:', page.url)
        if '--lifecycle' in __import__('sys').argv:
            user32 = ctypes.windll.user32
            kernel32 = ctypes.windll.kernel32
            user32.PostMessageW.argtypes = [wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM]
            user32.IsWindowVisible.argtypes = [wintypes.HWND]
            user32.GetWindowTextW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
            kernel32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
            kernel32.OpenProcess.restype = wintypes.HANDLE
            kernel32.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
            kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
            windows = []
            callback_type = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
            def find_main(hwnd, _):
                owner = wintypes.DWORD()
                user32.GetWindowThreadProcessId(hwnd, ctypes.byref(owner))
                title = ctypes.create_unicode_buffer(256)
                user32.GetWindowTextW(hwnd, title, 256)
                if owner.value == proc.pid and title.value == 'AssetVault': windows.append(hwnd)
                return True
            callback = callback_type(find_main)
            user32.EnumWindows(callback, 0)
            assert len(windows) == 1, windows
            hwnd = windows[0]
            roaming = Path(os.environ['APPDATA'])
            lock = next(candidate for candidate in [roaming / 'AssetVault/data/manager.lock', roaming / 'com.assetvault.desktop/data/manager.lock'] if candidate.exists())
            backend_pid = json.loads(lock.read_text())['pid']
            backend_handle = kernel32.OpenProcess(0x00100000, False, backend_pid)
            assert backend_handle
            try:
                assert user32.PostMessageW(hwnd, 0x0010, 0, 0)  # WM_CLOSE
                deadline = time.monotonic() + 5
                while user32.IsWindowVisible(hwnd) and time.monotonic() < deadline: time.sleep(.05)
                assert not user32.IsWindowVisible(hwnd)
                assert proc.poll() is None
                assert kernel32.WaitForSingleObject(backend_handle, 0) == 258
                second = subprocess.Popen([executable], env=env)
                try: assert second.wait(timeout=15) == 0
                finally:
                    if second.poll() is None: second.terminate(); second.wait(timeout=5)
                deadline = time.monotonic() + 5
                while not user32.IsWindowVisible(hwnd) and time.monotonic() < deadline: time.sleep(.05)
                assert user32.IsWindowVisible(hwnd), 'Second launch must restore hidden main window'
                assert json.loads(lock.read_text())['pid'] == backend_pid
                print('PASS: close hides window; repeated launch restores the same instance and backend')
                bridge = page.evaluate("Promise.race([window.__TAURI__.core.invoke('backend_startup_error').then(value=>({ok:true,value}),error=>({error:String(error)})),new Promise(resolve=>setTimeout(()=>resolve({error:'IPC timed out'}),3000))])")
                print('Desktop IPC diagnostic:', bridge, flush=True)
                assert bridge.get('ok'), bridge
                crash = '--crash' in __import__('sys').argv
                if crash:
                    # Deliberately kill only the desktop, not /T: Windows must reap Node itself.
                    subprocess.run(['taskkill', '/PID', str(proc.pid), '/F'], check=True, capture_output=True)
                    proc.wait(timeout=10)
                else:
                    page.evaluate("window.dispatchEvent(new Event('assetvault:open-updates'))")
                    exit_button = page.get_by_role('button', name='退出应用', exact=True)
                    assert exit_button.is_visible()
                    exit_button.evaluate('(button)=>{button.click()}')
                    assert proc.wait(timeout=10) == 0
                assert kernel32.WaitForSingleObject(backend_handle, 5000) == 0
                print('PASS: desktop crash reaps backend' if crash else 'PASS: settings quit button exits desktop and reaps backend')
            finally:
                kernel32.CloseHandle(backend_handle)
        browser.close()
finally:
    if proc.poll() is None:
        # Restrict cleanup to the process tree started by this test.
        subprocess.run(['taskkill', '/PID', str(proc.pid), '/T', '/F'], capture_output=True)
