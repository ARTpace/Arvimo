"""Exercise update UI with a mock native bridge; never install or quit the app."""
from pathlib import Path
from playwright.sync_api import sync_playwright

source = (Path(__file__).resolve().parents[1] / 'src/library/app-updates.js').read_text(encoding='utf8')
with sync_playwright() as p:
    browser = p.chromium.launch(channel='chrome', headless=True)
    page = browser.new_page()
    page.set_content('<html><body></body></html>')
    page.evaluate('''() => {
      window.calls=[]; window.active=false;window.failDownload=true;
      window.__TAURI__={app:{getVersion:async()=> '0.1.7'},event:{listen:async(name,fn)=>{window.progress=fn}},core:{invoke:async(name)=>{
        calls.push(name);
        if(name==='check_app_update')return {available:true,version:'0.1.8',notes:'<script>unsafe</script>'};
        if(name==='download_app_update'&&failDownload)throw Error('network');
      }}};
      window.confirm=()=>true;
    }''')
    page.add_script_tag(content=source.replace('export function', 'function') + '\nwindow.ui=createAppUpdates({hasActiveTasks:()=>active});document.body.append(ui.card);')
    page.locator('[data-check]').click()
    assert '0.1.8' in page.locator('[data-status]').inner_text()
    assert page.locator('[data-notes]').inner_text() == '<script>unsafe</script>'
    page.locator('[data-action]').click()
    assert '下载失败' in page.locator('[data-status]').inner_text()
    page.evaluate('failDownload=false')
    page.locator('[data-action]').click()
    assert page.locator('[data-action]').inner_text() == '重启并更新'
    page.evaluate('active=true')
    page.locator('[data-action]').click()
    assert '任务' in page.locator('[data-status]').inner_text()
    assert 'install_app_update' not in page.evaluate('calls')
    page.evaluate('active=false')
    page.locator('[data-action]').click()
    assert page.evaluate('calls.at(-1)') == 'install_app_update'
    print('PASS: update check, safe notes, failed download/retry, active-task guard and install bridge')
    browser.close()
