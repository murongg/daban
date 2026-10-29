#!/usr/bin/env python3
"""A native GTK window showing one page of the shared browser, never a second profile."""
import argparse
import base64
from concurrent.futures import ThreadPoolExecutor
import json
from pathlib import Path
import threading
import time
import urllib.request
import gi
gi.require_version('Gtk', '3.0')
from gi.repository import Gdk, GdkPixbuf, GLib, Gtk

parser = argparse.ArgumentParser()
# The TypeScript screen owner and API router validate logical Bot IDs; this adapter must not restrict them to old slots.
parser.add_argument('--bot', required=True)
parser.add_argument('--origin', required=True)
parser.add_argument('--token-file', required=True)
parser.add_argument('--layout-file', required=True)
args = parser.parse_args()
token = Path(args.token_file).read_text().strip()
opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
executor = ThreadPoolExecutor(max_workers=1)

def request(path, body=None):
    headers = {'x-prototype-token': token}
    if body is not None:
        headers['content-type'] = 'application/json'
    req = urllib.request.Request(args.origin + path, data=json.dumps(body).encode() if body is not None else None, headers=headers)
    with opener.open(req, timeout=4) as response:
        return response.read()

class Viewer(Gtk.Window):
    def __init__(self):
        super().__init__(title='共享浏览器 · Bot ' + args.bot.upper())
        self.set_wmclass('browser-' + args.bot, 'BotBrowser')
        self.set_default_size(1020, 720)
        self.lease = {'owner': 'agent', 'epoch': -1}
        self.binding = None
        self.pending_binding = None
        self.paused = False
        self.pixbuf = None
        self.rect = (0, 0, 960, 640)
        self.alive = True
        box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL)
        self.add(box)
        toolbar = Gtk.Box(spacing=12)
        toolbar.set_border_width(10)
        self.status = Gtk.Label(label='正在连接共享浏览器…')
        toolbar.pack_start(self.status, True, True, 0)
        toolbar.pack_end(Gtk.Label(label='共用浏览器会话 · Bot ' + args.bot.upper()), False, False, 0)
        box.pack_start(toolbar, False, False, 0)
        self.area = Gtk.DrawingArea()
        self.area.set_can_focus(True)
        self.area.add_events(Gdk.EventMask.BUTTON_PRESS_MASK | Gdk.EventMask.KEY_PRESS_MASK | Gdk.EventMask.SCROLL_MASK)
        self.area.connect('draw', self.draw)
        self.area.connect('button-press-event', self.click)
        self.area.connect('key-press-event', self.key)
        box.pack_start(self.area, True, True, 0)
        self.connect('destroy', self.destroyed)
        self.show_all()
        threading.Thread(target=self.poll, daemon=True).start()

    def destroyed(self, *_):
        self.alive = False
        Gtk.main_quit()

    def poll(self):
        while self.alive:
            try:
                state = json.loads(request('/viewer/' + args.bot))
                view = state['view']
                lease = state['lease']
                if view['epoch'] != lease['epoch']:
                    lease = {'owner': 'handoff', 'epoch': view['epoch']}
                frame = base64.b64decode(view['image'].split(',', 1)[1], validate=True) if view.get('image') else None
                GLib.idle_add(self.received, frame, lease, view['binding'], view.get('paused', False))
            except Exception:
                GLib.idle_add(self.status.set_text, '等待连接共享浏览器…')
            time.sleep(.35)

    def received(self, frame, lease, binding, paused):
        if frame:
            loader = GdkPixbuf.PixbufLoader.new_with_type('jpeg')
            loader.write(frame)
            loader.close()
            self.pixbuf = loader.get_pixbuf()
        self.paused = paused
        self.lease = {'owner': lease['owner'], 'epoch': lease['epoch']}
        self.pending_binding = binding
        self.status.set_text('网页正在等待确认，请到客户端浏览器面板处理' if paused else '共享登录状态 · 独立标签' + (' · 用户控制中' if lease['owner'] == 'human' else ' · 只读观看'))
        self.area.queue_draw()
        return False

    def draw(self, area, cr):
        cr.set_source_rgb(.96, .96, .95)
        cr.paint()
        if not self.pixbuf:
            return False
        width, height = area.get_allocated_width(), area.get_allocated_height()
        scale = min(width / 960, height / 640)
        w, h = int(960 * scale), int(640 * scale)
        x, y = (width - w) // 2, (height - h) // 2
        self.rect = (x, y, w, h)
        scaled = self.pixbuf.scale_simple(w, h, GdkPixbuf.InterpType.BILINEAR)
        Gdk.cairo_set_source_pixbuf(cr, scaled, x, y)
        cr.paint()
        self.binding = self.pending_binding
        origin = area.get_window().get_origin()
        root_x, root_y = origin[-2], origin[-1]
        Path(args.layout_file).write_text(json.dumps({'x': root_x + x, 'y': root_y + y, 'width': w, 'height': h, 'owner': self.lease['owner'], 'epoch': self.lease['epoch'], 'updatedAt': time.time() * 1000}))
        return False

    def send(self, event):
        if self.lease['owner'] != 'human' or not self.binding or self.paused:
            return
        epoch = self.lease['epoch']
        binding = dict(self.binding)
        def forward():
            try:
                request('/viewer/' + args.bot + '/input', {'epoch': epoch, 'binding': binding, 'input': event})
            except Exception:
                GLib.idle_add(self.status.set_text, '输入未发送：请确认接管状态')
        executor.submit(forward)

    def click(self, area, event):
        area.grab_focus()
        x, y, w, h = self.rect
        if event.button == 1 and x <= event.x < x + w and y <= event.y < y + h:
            self.send({'type': 'click', 'x': (event.x - x) * 960 / w, 'y': (event.y - y) * 640 / h})
        return True

    def key(self, area, event):
        name = Gdk.keyval_name(event.keyval)
        ctrl = bool(event.state & Gdk.ModifierType.CONTROL_MASK)
        if ctrl and name.lower() == 'v':
            value = Gtk.Clipboard.get(Gdk.SELECTION_CLIPBOARD).wait_for_text()
            if value:
                self.send({'type': 'text', 'text': value[:2000]})
        elif ctrl and name.lower() == 'a':
            self.send({'type': 'key', 'key': 'ControlOrMeta+A'})
        else:
            keys = {'Return': 'Enter', 'Tab': 'Tab', 'BackSpace': 'Backspace', 'Delete': 'Delete', 'Left': 'ArrowLeft', 'Right': 'ArrowRight', 'Up': 'ArrowUp', 'Down': 'ArrowDown', 'Escape': 'Escape', 'Home': 'Home', 'End': 'End'}
            if name in keys:
                self.send({'type': 'key', 'key': keys[name]})
            elif not ctrl:
                value = Gdk.keyval_to_unicode(event.keyval)
                if value and chr(value).isprintable():
                    self.send({'type': 'text', 'text': chr(value)})
        return True

Viewer()
Gtk.main()
executor.shutdown(wait=False, cancel_futures=True)
