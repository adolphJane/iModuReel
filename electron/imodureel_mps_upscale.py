from comfy_api.latest import ComfyExtension
from comfy_extras.nodes_upscale_model import ImageUpscaleWithModel


class ContiguousModel:
    def __init__(self, model):
        self.model_descriptor = model

    def __getattr__(self, name):
        return getattr(self.model_descriptor, name)

    def __call__(self, tile):
        return self.model_descriptor(tile.contiguous())


class MpsUpscale(ImageUpscaleWithModel):
    @classmethod
    def define_schema(cls):
        schema = super().define_schema()
        schema.node_id = "iModuReelMpsUpscale"
        return schema

    @classmethod
    def execute(cls, upscale_model, image):
        return super().execute(ContiguousModel(upscale_model), image)


class IModuReelExtension(ComfyExtension):
    async def get_node_list(self):
        return [MpsUpscale]


async def comfy_entrypoint():
    return IModuReelExtension()
