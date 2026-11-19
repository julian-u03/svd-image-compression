"""Image preparation, rank selection and PNG export, independent of the DOM.

Runs in Pyodide; the JavaScript worker only transports files and results.
"""
from io import BytesIO
from math import floor

import numpy as np
from PIL import Image, ImageOps, UnidentifiedImageError

from svd import compute_svd, recommend_rank, reconstruct, relative_error


def processing_size(width, height, resolution):
    """Bound the longest side, preserving aspect ratio without upscaling."""
    if resolution == "original":
        return width, height
    if str(resolution) not in {"64", "128", "512"}:
        raise ValueError("Choose 64, 128, 512 or Original.")
    scale = min(1.0, int(resolution) / max(width, height))
    return max(1, floor(width * scale + 0.5)), max(1, floor(height * scale + 0.5))


def png_bytes(image):
    output = BytesIO()
    image.save(output, format="PNG")
    return output.getvalue()


def export_matrix(matrix):
    """Quantize only after numerical checks, with fixed black/white endpoints."""
    pixels = np.floor(np.clip(matrix, 0.0, 1.0) * 255.0 + 0.5).astype(np.uint8)
    return png_bytes(Image.fromarray(pixels))


class CompressionSession:
    """One source, prepared image and cached SVD per worker.

    The worker supplies the UI resource limits, avoiding two copies of resource bounds.
    All source/result data remains in memory, never in persistent storage.
    """
    def __init__(self, limits, progress=lambda message: None):
        self.limits = limits
        self.progress = progress
        self.source = self.matrix = self.factors = self.recommendation = None

    def can_process(self, width, height):
        return (width * height <= self.limits["maxProcessingPixels"]
                and min(width, height) <= self.limits["maxSvdDimension"])

    def load_image(self, data):
        """Check dimensions before full decoding; normalize EXIF orientation."""
        self.source = self.matrix = self.factors = self.recommendation = None
        if not len(data) or len(data) > self.limits["maxFileBytes"]:
            raise ValueError("Choose an image of at most 20 MiB.")
        try:
            with Image.open(BytesIO(bytes(data))) as image:
                if image.width * image.height > self.limits["maxSourcePixels"]:
                    raise ValueError("The source exceeds 32 million pixels. Resize it first.")
                image.load()
                oriented = ImageOps.exif_transpose(image)
                rgba = oriented.convert("RGBA")
                white = Image.new("RGBA", rgba.size, (255, 255, 255, 255))
                self.source = Image.alpha_composite(white, rgba).convert("L")
        except (UnidentifiedImageError, OSError, Image.DecompressionBombError) as error:
            raise ValueError("This image could not be decoded. Try PNG, JPEG or WebP.") from error
        width, height = self.source.size
        choices = []
        for value in ("64", "128", "512", "original"):
            w, h = processing_size(width, height, value)
            supported = self.can_process(w, h)
            choices.append({"value": value, "width": w, "height": h,
                            "supported": supported,
                            "disabled": not supported or (value != "original" and (w, h) == (width, height))})
        return {"width": width, "height": height, "resolutions": choices}

    def prepare(self, resolution):
        if self.source is None:
            raise ValueError("Choose an image first.")
        width, height = processing_size(*self.source.size, resolution)
        if not self.can_process(width, height):
            raise ValueError("Unsupported dimensions. Choose a lower resolution.")
        self.matrix = self.factors = self.recommendation = None
        image = self.source.resize((width, height), Image.Resampling.LANCZOS)
        # Fixed scaling preserves brightness; do not use per-image min/max.
        self.matrix = np.asarray(image, dtype=np.float64) / 255.0
        return {"width": width, "height": height, "max_rank": min(width, height),
                "png": png_bytes(image)}

    def calculate(self, ranks):
        if self.matrix is None:
            raise ValueError("Prepare an image before calculating.")
        height, width = self.matrix.shape
        max_rank = min(height, width)
        if (len(ranks) != 3 or any(isinstance(k, bool) or not isinstance(k, int)
                                  or not 1 <= k <= max_rank for k in ranks)):
            raise ValueError(f"Enter three integer ranks between 1 and {max_rank}.")
        cached = self.factors is not None
        if not cached:
            self.progress("Starting the direct Python SVD…")
            self.factors = compute_svd(self.matrix, self.progress)
        s = self.factors[1]
        threshold = max(self.matrix.shape) * np.finfo(np.float64).eps * s[0]
        numerical_rank = int(np.count_nonzero(s > threshold))
        if self.recommendation is None:
            self.progress("Checking the 5% recommendation…")
            self.recommendation = recommend_rank(self.matrix, self.factors)
        rank, error, approximation = self.recommendation
        entries = {}

        def make_entry(k, matrix=None, measured_error=None):
            if k not in entries:
                self.progress(f"Reconstructing and encoding rank {k}…")
                matrix = reconstruct(self.factors, k) if matrix is None else matrix
                measured_error = relative_error(self.matrix, matrix) if measured_error is None else measured_error
                # Theoretical scalar counts, with equal bytes per value and no overhead.
                entries[k] = {"rank": k, "numerical_components": min(k, numerical_rank),
                              "svd_value_savings": 1 - k * (height + width + 1) / self.matrix.size,
                              "relative_error": measured_error, "png": export_matrix(matrix)}
            return entries[k].copy()

        recommendation = make_entry(rank, approximation, error)
        recommendation["error_limit"] = 0.05
        approximations = [make_entry(k) for k in ranks]
        return {"approximations": approximations, "recommendation": recommendation,
                "singular_values": s[:numerical_rank].tolist(), "max_rank": max_rank,
                "ranks": ranks, "svd_cached": cached}
