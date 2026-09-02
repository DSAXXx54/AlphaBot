"""Shared client-decryptable AES-GCM envelope helpers.

Browser clients receive the matching material, so this is a rotating
obfuscation layer rather than a server-side secret boundary.
"""

from __future__ import annotations

import base64
import hashlib
import json
import os
from typing import Any

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from app.core.config import settings


def _key() -> bytes:
    material = settings.APP_CIPHER_KEY_MATERIAL.strip()
    if not material:
        raise RuntimeError("APP_CIPHER_KEY_MATERIAL is not configured")
    return hashlib.sha256(material.encode("utf-8")).digest()


def encrypt_client_payload(payload: dict[str, Any], *, aad: bytes) -> dict[str, str]:
    """Encrypt a JSON payload into the compact ``v1.<base64url>`` envelope."""
    iv = os.urandom(12)
    plaintext = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    ciphertext = AESGCM(_key()).encrypt(iv, plaintext, aad)
    encoded = base64.urlsafe_b64encode(iv + ciphertext).rstrip(b"=").decode("ascii")
    return {"payload": f"v1.{encoded}"}
