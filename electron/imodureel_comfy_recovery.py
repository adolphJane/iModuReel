import json
import logging
import os
import re
from pathlib import Path


def save_completion(directory, prompt_id, outputs):
    if not re.fullmatch(r"[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}", prompt_id):
        return
    files = [
        {"filename": item["filename"], "subfolder": item.get("subfolder"), "type": item.get("type")}
        for node in outputs.values() if isinstance(node, dict)
        for items in node.values() if isinstance(items, list)
        for item in items if isinstance(item, dict)
        and isinstance(item.get("filename"), str) and item.get("type") != "temp"
    ]
    destination = directory / (prompt_id + ".json")
    temporary = destination.with_suffix(".tmp")
    try:
        directory.mkdir(parents=True, exist_ok=True)
        with temporary.open("w", encoding="utf-8") as stream:
            json.dump(files, stream)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, destination)
    except (OSError, TypeError, ValueError) as error:
        logging.warning("iModuReel could not save completed prompt outputs: %s", error)


directory = os.environ.get("IMODUREEL_COMPLETED_PROMPTS")
if directory:
    from execution import PromptQueue

    original_task_done = PromptQueue.task_done

    def task_done(self, item_id, history_result, status, process_item=None):
        # ComfyUI calls process_item before adding the result to its in-memory history.
        def record_completion(prompt):
            if status and status.completed and prompt[3].get("imodureel_keep_outputs") is True:
                save_completion(Path(directory), prompt[1], history_result.get("outputs", {}))
            return process_item(prompt) if process_item else prompt

        return original_task_done(self, item_id, history_result, status, process_item=record_completion)

    PromptQueue.task_done = task_done

NODE_CLASS_MAPPINGS = {}
