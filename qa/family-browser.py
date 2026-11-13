"""Execute the synthetic two-device integration at the production UI entry points."""
from pathlib import Path
from subprocess import Popen, PIPE
import sys
from playwright.sync_api import sync_playwright

home = Path(__file__).resolve().parent
with Popen(["node", str(home / "family-browser-server.mjs"), str(Path(sys.argv[1]).resolve())],stdout=PIPE,text=True) as server:
    try:
        port = int(server.stdout.readline().removeprefix("QA_PORT="))
        with sync_playwright() as pw:
            browser = getattr(pw,sys.argv[2]).launch()
            page = browser.new_page()
            page.goto(f"http://127.0.0.1:{port}/qa-scenario.html")
            page.get_by_role("button",name="运行双设备验收").click()
            page.get_by_text("PASS ·",exact=False).or_(page.get_by_text("FAIL ·",exact=False)).last.wait_for(timeout=150000)
            result = page.locator("#result").inner_text()
            assert "PASS ·" in result and "FAIL ·" not in result,result
            print(result)
            browser.close()
    finally:
        server.terminate()
