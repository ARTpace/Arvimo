"""Focused browser checks for settings navigation and existing AI controls, without live API calls."""
import argparse
import json
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

parser = argparse.ArgumentParser()
parser.add_argument('--url', default='http://127.0.0.1:18745')
parser.add_argument('--screenshot', default='artifacts/settings-panel.png')
args = parser.parse_args()
root = Path(__file__).resolve().parents[1]

with sync_playwright() as p:
    browser = p.chromium.launch(channel='chrome', headless=True)
    page = browser.new_page(viewport={'width': 1280, 'height': 900})
    errors = []
    saves = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.route('**/app.js', lambda route: route.fulfill(body='', content_type='text/javascript'))
    page.route('**/app.css', lambda route: route.fulfill(path=str(root / 'src/library/app.css'), content_type='text/css'))

    def ai_settings(route):
        if route.request.method == 'POST':
            saves.append(route.request.post_data_json)
        route.fulfill(json={'enabled': True, 'baseUrl': 'http://127.0.0.1:31415/v1', 'model': saves[-1]['model'] if saves else 'auto', 'hasKey': True})

    page.route('**/api/ai/settings', ai_settings)
    page.goto(args.url + '/src/library/index.html')
    page.wait_for_load_state('networkidle')
    page.evaluate("""async () => {
      const {createSettingsPanel}=await import('/src/library/settings-panel.js');
      const {createAISettings}=await import('/src/library/ai-settings.js');
      const $=selector=>document.querySelector(selector);
      const ai=createAISettings({$,toast:()=>{}});
      window.settingsTest=createSettingsPanel({$,loadAI:()=>ai.load()});
      window.exportSaves=0;$('#save-settings').onclick=()=>window.exportSaves++;
      settingsTest.open();
    }""")
    expect(page.locator('#settings-dialog')).to_be_visible()
    expect(page.locator('#settings-page-export')).to_be_visible()
    assert page.locator('#ai-dialog').count() == 0
    assert page.locator('#ai-settings-button').count() == 0
    page.locator('[data-settings-page="export"]').focus()
    page.keyboard.press('ArrowDown')
    expect(page.locator('#settings-page-storage')).to_be_visible()
    page.locator('#backend-folder').fill('H:/Models/unsaved')
    page.locator('[data-settings-page="ai"]').click()
    expect(page.locator('#ai-save')).to_be_enabled()
    expect(page.locator('#save-settings')).to_be_hidden()
    page.locator('#ai-model').fill('draft-model')
    page.locator('[data-settings-page="connections"]').click()
    expect(page.locator('#blender-bridge-status')).to_be_visible()
    expect(page.locator('#browser-runtime-status')).to_be_visible()
    page.locator('#settings-page-connections summary').first.click()
    expect(page.locator('#blender-bridge-status')).to_be_hidden()
    page.locator('[data-settings-page="storage"]').click()
    expect(page.locator('#backend-folder')).to_have_value('H:/Models/unsaved')
    page.locator('#save-settings').click()
    assert page.evaluate('exportSaves') == 1
    page.locator('[data-settings-page="ai"]').click()
    expect(page.locator('#ai-model')).to_have_value('draft-model')
    page.locator('#ai-save').click()
    expect(page.locator('#ai-status')).to_have_text('设置已保存。')
    assert len(saves) == 1 and saves[0]['model'] == 'draft-model'
    screenshot = root / args.screenshot
    screenshot.parent.mkdir(parents=True, exist_ok=True)
    page.screenshot(path=str(screenshot))
    page.set_viewport_size({'width': 640, 'height': 800})
    assert page.locator('.settings-content').evaluate('(el)=>el.scrollWidth<=el.clientWidth+1'), 'Settings overflow on narrow window'
    page.locator('[data-settings-page="export"]').click()
    assert page.locator('.settings-content').evaluate('(el)=>el.scrollWidth<=el.clientWidth+1'), 'Export settings overflow on narrow window'
    assert not errors, errors
    browser.close()
    print(json.dumps({'passed': True, 'checks': ['category navigation', 'keyboard navigation', 'collapsible groups', 'draft preservation', 'export handler preserved', 'AI save', 'narrow layout'], 'screenshot': str(screenshot)}))
