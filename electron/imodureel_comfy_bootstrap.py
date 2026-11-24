import os
import runpy
import sys
import threading


def wait_for_owner(pipe):
    try:
        while os.read(pipe.fileno(), 1):
            pass
    finally:
        os._exit(0)


# The desktop process keeps this pipe open for the life of its managed engine.
# Keep ComfyUI's own stdin non-interactive, as when it is launched with /dev/null.
owner_pipe = sys.stdin
sys.stdin = open(os.devnull, encoding="utf-8")
threading.Thread(target=wait_for_owner, args=(owner_pipe,), daemon=True).start()
sys.argv = sys.argv[1:]
runpy.run_path(sys.argv[0], run_name="__main__")
