"""M2b: a registry of trained latent mappers between model pairs.

A mapper carries a sender model's KV cache into a receiver model of a different
family. The registry keys mappers by (sender model hash, receiver model hash) and
backs GET /latent/mappers and POST /latent/transfer. It starts empty. When the
runtime starts with LATENT_MAPPER=<checkpoint>, transfer.register_from_env loads
that one trained pair and registers its TransferService here. One pair is trained
so far (Qwen2.5-0.5B to SmolLM2-360M, docs/m2b-transfer.md).

/latent/transfer answers 501 when no mapper is registered for the requested
sender and receiver, for example when LATENT_MAPPER is not set.
"""

import hashlib
import threading

from . import ApiError

NO_MAPPER = "No trained mapper for this model pair."


def model_hash(model_id):
    """sha256 hex of the model id string, e.g. "Qwen/Qwen2.5-7B-Instruct-AWQ"."""
    return hashlib.sha256(model_id.encode("utf-8")).hexdigest()


class MapperRegistry:
    """Mappers keyed by (sender model hash, receiver model hash)."""

    def __init__(self):
        self._pairs = {}
        self._lock = threading.Lock()

    def register(self, sender_model, receiver_model, mapper, name=None):
        """mapper is a callable taking the transfer request body and returning a dict."""
        key = (model_hash(sender_model), model_hash(receiver_model))
        with self._lock:
            self._pairs[key] = {"mapper": mapper, "name": name or f"{sender_model} -> {receiver_model}"}

    def lookup(self, sender_model, receiver_model):
        with self._lock:
            entry = self._pairs.get((model_hash(sender_model), model_hash(receiver_model)))
        return entry["mapper"] if entry else None

    def pairs(self):
        with self._lock:
            return [
                {"sender": sender, "receiver": receiver, "name": entry["name"]}
                for (sender, receiver), entry in sorted(self._pairs.items())
            ]

    def transfer(self, body):
        sender, receiver = body.get("sender"), body.get("receiver")
        if not isinstance(sender, str) or not sender or not isinstance(receiver, str) or not receiver:
            raise ApiError(400, "sender and receiver must be model id strings.")
        mapper = self.lookup(sender, receiver)
        if mapper is None:
            raise ApiError(501, NO_MAPPER)
        return mapper(body)
