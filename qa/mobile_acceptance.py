"""Run against local, synthetic IndexedDB data. Usage: python mobile_acceptance.py STATIC_DIRECTORY webkit|chromium"""
import base64
from functools import partial
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
import json
import os
import re
from pathlib import Path
from random import Random
from shutil import copytree
import struct
import sys
from tempfile import TemporaryDirectory
from threading import Thread
import zlib

from playwright.sync_api import expect, sync_playwright


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


def test_image():
    def chunk(tag, data):
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data))
    width, height = 2300, 1600
    random = Random(120)
    pixels = b"".join(b"\0" + random.randbytes(width) for _ in range(height))
    header = struct.pack(">2I5B", width, height, 8, 0, 0, 0, 0)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header) + chunk(b"IDAT", zlib.compress(pixels)) + chunk(b"IEND", b"")


def exercise(page, context, host):
    errors = []
    page.on("pageerror", lambda exc: errors.append(str(exc)))
    page.clock.set_fixed_time("2026-08-11T12:00:00+08:00")
    page.goto(host + "/xiaomoli-journal/")
    expect(page.locator("body")).to_have_attribute("data-locked", "false")
    home = page.locator("#home")
    form = page.locator("#entryDialog")
    click_tab = lambda tab: page.locator(f'[data-tab="{tab}"]').click()
    tap = lambda kind: home.locator(f'[data-action="{kind}"]').click()

    # Every record editor can be dismissed before filling even its mandatory fields.
    click_tab("timeline")
    for kind in ["喂奶", "睡眠", "尿尿", "便便", "用药", "营养品", "体温", "疫苗", "成长测量"]:
        page.locator("#timeline [data-compose]").click()
        page.locator("#composeList").get_by_role("button", name=kind, exact=True).click()
        expect(form).to_be_visible()
        if kind == "用药":
            form.locator('[name="item"]').fill("未保存的测试")
            page.set_viewport_size({"width":390,"height":380})
            form.locator('[name="note"]').focus()
            form.evaluate("(dialog) => { dialog.scrollTop = dialog.scrollHeight; }")
            # The sticky cancel control stays within the visible part of the device.
            page.wait_for_function("""() => {
                const b = document.querySelector('#cancelEntry').getBoundingClientRect();
                return b.top >= -1 && b.bottom <= window.visualViewport.height + 1;
            }""")
        form.get_by_role("button", name="取消").click()
        expect(form).to_be_hidden()
        page.set_viewport_size({"width":390,"height":844})
    expect(page.locator("#timelineList .entry-row")).to_have_count(0)

    # A historical sleep spans midnight, and a day with no start still has a visible interval.
    page.locator("#dateFilter").fill("2026-08-09")
    expect(page.locator("#timelineHeading")).to_contain_text("8月9日")
    page.locator("#timeline [data-compose]").click()
    page.locator("#composeList").get_by_role("button", name="睡眠", exact=True).click()
    form.locator('[name="time"]').fill("23:50")
    form.locator('[name="duration"]').fill("35")
    expect(form.locator('[name="date"]')).to_have_value("2026-08-09")
    expect(form.locator('[name="time"]')).to_have_value(re.compile(r"^23:50(?::00(?:\.0+)?)?$"))
    expect(form.locator('[name="duration"]')).to_have_value("35")
    page.locator("#submitEntry").click()
    expect(form).to_be_hidden()
    expect(page.locator("#timelineSummary")).to_contain_text("当日睡眠 10 分钟")
    page.locator("#dateFilter").fill("2026-08-10")
    expect(page.locator("#timelineSummary")).to_contain_text("当日睡眠 25 分钟")
    expect(page.locator("#timelineSummary")).to_contain_text("1 条跨日延续")
    expect(page.locator("#timelineList .entry-row")).to_have_count(1)

    click_tab("home")
    tap("med")
    form.locator('[name="item"]').fill("测试药品")
    form.locator('[name="dose"]').fill("1")
    form.locator('[name="unit"]').fill("份")
    page.locator("#submitEntry").click()
    expect(form).to_be_hidden()
    tap("supplement")
    form.locator('[name="item"]').fill("测试益生菌")
    page.locator("#submitEntry").click()
    expect(form).to_be_hidden()

    # Timers survive reload and continue from wall clock timestamps across midnight.
    page.clock.set_fixed_time("2026-08-11T23:50:00+08:00")
    tap("feed")
    page.locator("#homeTimeline").get_by_role("button", name="计时左侧").click()
    expect(page.locator("#homeTimeline")).to_contain_text("左侧计时中")
    page.clock.set_fixed_time("2026-08-11T23:57:00+08:00")
    page.locator("#homeTimeline").get_by_role("button", name="换到右侧").click()
    expect(page.locator("#homeTimeline")).to_contain_text("右侧计时中")
    page.clock.set_fixed_time("2026-08-12T00:10:00+08:00")
    page.reload()
    expect(page.locator("#homeTimeline")).to_contain_text("右侧计时中")
    page.locator("#homeTimeline").get_by_role("button", name="结束喂奶").click()
    expect(home.locator('[data-action="feed"]')).to_have_attribute("aria-label", "喂奶")
    click_tab("timeline")
    expect(page.locator("#timelineSummary")).to_contain_text("当日亲喂 10 分钟")
    expect(page.locator("#timelineList")).to_contain_text("左侧 7 分钟")
    expect(page.locator("#timelineList")).to_contain_text("右侧 13 分钟")

    click_tab("home")
    tap("pee")
    expect(page.locator("#peeCount")).to_have_text("1 次")
    tap("poop")
    page.get_by_role("button", name="添加照片", exact=True).click()
    form.locator('input[type=file]').last.set_input_files({"name":"texture.png", "mimeType":"image/png","buffer":test_image()})
    expect(form.locator(".entry-photo-size")).to_be_visible()
    expect(page.locator("#submitEntry")).to_be_enabled()
    page.locator("#submitEntry").click()
    expect(form).to_be_hidden()
    page.locator("#homeTimeline").get_by_role("button", name="查看照片",exact=True).click()
    page.wait_for_function("document.querySelector('#photoFull').naturalWidth>0")
    assert page.locator("#photoFull").evaluate("img=>Math.max(img.naturalWidth,img.naturalHeight)") <= 1600
    page.locator("#photoClose").click()

    # Edit, confirm delete and undo through exactly the controls a parent uses.
    click_tab("timeline")
    pee = page.locator("#timelineList .entry-row").filter(has_text="尿尿")
    pee.locator(".entry-menu").click()
    page.locator("#actionEdit").click()
    form.locator('[name="note"]').fill("修改后")
    page.locator("#submitEntry").click()
    expect(pee).to_contain_text("修改后")
    pee.locator(".entry-menu").click()
    page.locator("#actionDelete").click()
    page.locator("#cancelDelete").click()
    expect(pee).to_have_count(1)
    pee.locator(".entry-menu").click()
    page.locator("#actionDelete").click()
    page.locator("#confirmDelete").click()
    expect(pee).to_have_count(0)
    page.locator("#toast").get_by_role("button", name="撤销", exact=True).click()
    expect(pee).to_contain_text("修改后")

    click_tab("profile")
    with page.expect_download() as downloaded:
        page.locator("#exportBackup").click()
    backup = Path(downloaded.value.path()).read_bytes()
    data = json.loads(backup)
    assert len(data["events"]) == 6
    rows = {x["type"]:x for x in data["events"]}
    assert rows["feed"]["extra"]["side"] == "双侧" and rows["feed"]["extra"]["method"] == "母乳"
    image = base64.b64decode(rows["poop"]["extra"]["photo"]["data"])
    assert image.startswith(b"\xff\xd8") and 0 < len(image) <= 350 * 1024
    assert rows["med"]["extra"]["item"] == "测试药品" and rows["supplement"]["extra"]["item"] == "测试益生菌"

    # Verify browser Service Worker controls the document and the app cold-starts offline.
    page.evaluate("navigator.serviceWorker.ready.then(() => true)")
    if not page.evaluate("!!navigator.serviceWorker.controller"):
        page.reload()
    page.wait_for_function("!!navigator.serviceWorker.controller")
    context.set_offline(True)
    page.reload(wait_until="domcontentloaded")
    expect(page.locator("body")).to_have_attribute("data-locked", "false")
    click_tab("home")
    expect(page.locator("#peeCount")).to_have_text("1 次")
    tap("pee")
    expect(page.locator("#peeCount")).to_have_text("2 次")
    context.set_offline(False)

    # Restore the picture and selected date in an empty installation, without replacing the first.
    page.goto(host + "/blank-journal/")
    expect(page.locator("body")).to_have_attribute("data-locked", "false")
    click_tab("profile")
    page.locator("#backupFile").set_input_files({"name":"backup.json","mimeType":"application/json","buffer":backup})
    expect(page.locator("#restoreDetail")).to_contain_text("1 张照片")
    page.locator("#cancelRestore").click()
    page.locator("#backupFile").set_input_files({"name":"backup.json","mimeType":"application/json","buffer":backup})
    page.locator("#confirmRestore").click()
    expect(page.locator("#backupStatus")).to_contain_text("已恢复")
    click_tab("home")
    expect(page.locator("#peeCount")).to_have_text("1 次")
    page.locator("#homeTimeline").get_by_role("button", name="查看照片",exact=True).click()
    page.wait_for_function("document.querySelector('#photoFull').naturalWidth>0")
    page.locator("#photoClose").click()
    assert not errors, errors


def main():
    source = Path(sys.argv[1]).resolve()
    engine_name = sys.argv[2]
    assert engine_name in {"webkit", "chromium"}
    with TemporaryDirectory() as tmp:
        for folder in ("xiaomoli-journal", "blank-journal"):
            dest = Path(tmp) / folder
            dest.mkdir()
            for path in source.iterdir():
                if path.is_file() and (path.suffix in {".html", ".js", ".css", ".png", ".webp", ".webmanifest", ".json", ".svg"}):
                    (dest / path.name).write_bytes(path.read_bytes())
            if (source / "assets").is_dir():
                copytree(source / "assets", dest / "assets")
        server = ThreadingHTTPServer(("127.0.0.1", 0), partial(QuietHandler,directory=tmp))
        Thread(target=server.serve_forever,daemon=True).start()
        try:
            with sync_playwright() as api:
                options = {}
                if os.getenv("PLAYWRIGHT_EXECUTABLE"): options["executable_path"] = os.environ["PLAYWRIGHT_EXECUTABLE"]
                browser = getattr(api,engine_name).launch(**options)
                try:
                    context = browser.new_context(viewport={"width":390,"height":844},is_mobile=True,has_touch=True,timezone_id="Asia/Shanghai",accept_downloads=True)
                    page = context.new_page()
                    page.set_default_timeout(15000)
                    try:
                        exercise(page,context,f"http://127.0.0.1:{server.server_port}")
                    except Exception:
                        # This local test uses only synthetic form inputs. Skip secrets and binary fields.
                        details = page.evaluate("""() => {
                            const dialog=document.querySelector('dialog[open]');
                            const fields=[...(dialog?.querySelectorAll('input,select,textarea') || [])];
                            return {clock:new Date().toString(), title:dialog?.querySelector('h2')?.textContent,
                                status:dialog?.querySelector('[role=status]')?.textContent,
                                selectedDate:document.querySelector('#dateFilter')?.value,
                                summary:document.querySelector('#timelineSummary')?.textContent,
                                form:fields.filter(f=>!['password','file'].includes(f.type) && f.closest('#entryForm'))
                                  .map(f=>({name:f.name,type:f.type,value:f.value,enabled:!f.disabled,checked:f.checked,
                                    invalid:f.willValidate && !f.validity.valid,reason:f.validationMessage})),
                                submitDisabled:dialog?.querySelector('[type=submit]')?.disabled
                            };
                        }""")
                        print("UI diagnostics", json.dumps(details, ensure_ascii=False), flush=True)
                        raise
                    print("PASS",engine_name,"mobile entry, cancellation, cross-midnight timeline, timers, edit/delete/undo, photo, restore and offline reopen.")
                finally: browser.close()
        finally:
            server.shutdown()
            server.server_close()


if __name__ == "__main__":
    main()
