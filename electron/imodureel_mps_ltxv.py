from types import SimpleNamespace

import torch

import comfy.sd
import comfy.utils
import folder_paths
from comfy.text_encoders import lt


class MappedLTXVTextEncoder:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"clip_name": (folder_paths.get_filename_list("text_encoders"),)}}

    RETURN_TYPES = ("CLIP",)
    FUNCTION = "load"
    CATEGORY = "iModuReel"

    def load(self, clip_name):
        path = folder_paths.get_full_path_or_raise("text_encoders", clip_name)
        weights = comfy.utils.load_torch_file(path, safe_load=True)
        cpu = torch.device("cpu")
        dtype = torch.float16
        if not weights or any(weight.device != cpu or weight.dtype != dtype for weight in weights.values()):
            raise ValueError("The LTX Video preset requires the FP16 T5 XXL text encoder.")

        target = SimpleNamespace(params={}, clip=lt.ltxv_te(dtype_t5=dtype), tokenizer=lt.LTXVT5Tokenizer)
        clip = comfy.sd.CLIP(
            target,
            embedding_directory=folder_paths.get_folder_paths("embeddings"),
            model_options={"dtype": dtype, "load_device": cpu, "offload_device": cpu,
                           "initial_device": torch.device("meta")},
        )
        model = clip.cond_stage_model
        transformer = getattr(model, model.clip).transformer
        # This checkpoint also includes the alias ignored by the stock T5 loader.
        weights.pop("encoder.embed_tokens.weight", None)
        # The original loader copies the file-backed tensors into anonymous RAM.
        # Keep the same FP16 tensors and let the OS reclaim clean pages as needed.
        transformer.load_state_dict(weights, strict=True, assign=True)
        return (clip,)


def float_attention(function, *args, **kwargs):
    kwargs["attn_precision"] = torch.float32
    return function(*args, **kwargs)


class LTXVAttention:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"model": ("MODEL",)}}

    RETURN_TYPES = ("MODEL",)
    FUNCTION = "patch"
    CATEGORY = "iModuReel"

    def patch(self, model):
        # Pin the score computation to FP32 on MPS, including BF16 checkpoints.
        patched = model.clone()
        patched.model_options["transformer_options"]["optimized_attention_override"] = float_attention
        return (patched,)


class CheckedLTXVLatents:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"samples": ("LATENT",)}}

    RETURN_TYPES = ("LATENT",)
    FUNCTION = "check"
    CATEGORY = "iModuReel"

    def check(self, samples):
        if not torch.isfinite(samples["samples"]).all().item():
            raise RuntimeError("动态镜头采样产生了无效数值，请重试生成")
        return (samples,)


NODE_CLASS_MAPPINGS = {
    "iModuReelLTXVTextEncoder": MappedLTXVTextEncoder,
    "iModuReelLTXVAttention": LTXVAttention,
    "iModuReelLTXVLatents": CheckedLTXVLatents,
}
