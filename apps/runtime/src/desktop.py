#!/usr/bin/env python3
"""Native X11 frame capture and clipboard-backed UTF-8 input for the local prototype."""
import os
import subprocess
import sys
from PIL import ImageGrab

if sys.argv[1] == 'frame':
    image = ImageGrab.grab(xdisplay=os.environ['DISPLAY'])
    image.save(sys.stdout.buffer, format='JPEG', quality=88)
elif sys.argv[1] == 'text':
    text = sys.stdin.buffer.read(8001)
    assert len(text) <= 8000 and b'\0' not in text
    window = subprocess.check_output(['xdotool', 'getactivewindow'], text=True).strip()
    kind = subprocess.check_output(['xprop', '-id', window, 'WM_CLASS'], text=True)
    terminal = 'XTerm' in kind
    # Taking PRIMARY from a GTK editor clears its selection and breaks select-all/paste.
    selection = 'primary' if terminal else 'clipboard'
    subprocess.run(['xclip', '-in', '-selection', selection], input=text, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True, timeout=3)
    shortcut = 'shift+Insert' if terminal else 'ctrl+v'
    subprocess.run(['xdotool', 'key', '--clearmodifiers', shortcut], check=True, timeout=3)
else:
    raise SystemExit('Unknown desktop helper operation')
