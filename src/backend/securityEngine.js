/*
=============================================================================
MODULE: backend/securityEngine.js
VERSION: v5009-FISCAL-V20.1
BASE: v5007.4-FINAL + Directriz V20 (IDs nativa en ingles)
RESPONSIBILITY: Hashes criptograficos (SHA-256, HMAC-SHA256), JWT y
                comparacion timing-safe.
STANDARDS: G10 ASCII Strict.

FIXES APLICADOS v5009-FISCAL-V20.1:
  - V20-01: sin renombrados funcionales. El modulo solo importa JWT de
            internalConfig (no renombrado) y opera sobre strings.

CORRECTIONS (heredadas):
  [SEC-01..SEC-05].
=============================================================================
*/

import { getSecret } from "wix-secrets-backend";
import { SECRETS } from "backend/mmSecrets";
import { JWT } from "backend/internalConfig";
import { logger } from "backend/logger";

const log = logger;

const HEX_64_PATTERN = /^[0-9a-f]{64}$/i;
const ZERO_HASH = "0".repeat(64);

// =============================================================================
// BLOQUE 1 - UTILIDADES INTERNAS
// =============================================================================

function _toString(value) {
    if (value === null || value === undefined) {
        return "";
    }

    return String(value);
}

function _toUtf8Bytes(value) {
    const text = _toString(value);

    if (typeof TextEncoder === "function") {
        return new TextEncoder().encode(text);
    }

    return Uint8Array.from(
        unescape(encodeURIComponent(text)),
        (character) => character.charCodeAt(0)
    );
}

function _bytesToHex(bytes) {
    return Array.from(bytes)
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("");
}

function _base64UrlEncode(value) {
    try {
        const bytes = _toUtf8Bytes(value);
        let binary = "";

        for (const byte of bytes) {
            binary += String.fromCharCode(byte);
        }

        return btoa(binary)
            .replace(/\+/g, "-")
            .replace(/\//g, "_")
            .replace(/=+$/g, "");
    } catch {
        return "";
    }
}

function _base64UrlDecode(value) {
    try {
        const normalized = _toString(value)
            .replace(/-/g, "+")
            .replace(/_/g, "/");

        const padded = normalized.padEnd(
            normalized.length + ((4 - (normalized.length % 4)) % 4),
            "="
        );

        const binary = atob(padded);
        const bytes = Uint8Array.from(binary, (character) =>
            character.charCodeAt(0)
        );

        if (typeof TextDecoder === "function") {
            return new TextDecoder().decode(bytes);
        }

        let escaped = "";

        for (const byte of bytes) {
            escaped += `%${byte.toString(16).padStart(2, "0")}`;
        }

        return decodeURIComponent(escaped);
    } catch {
        return "";
    }
}

function _parseJson(value) {
    try {
        const parsed = JSON.parse(value);

        return parsed && typeof parsed === "object" ? parsed : null;
    } catch {
        return null;
    }
}

function _isValidHexSignature(value) {
    return HEX_64_PATTERN.test(_toString(value));
}

// =============================================================================
// BLOQUE 2 - HASH SHA-256
// =============================================================================

export async function hashSHA256(input) {
    const value = _toString(input);

    if (!value) {
        return ZERO_HASH;
    }

    if (
        typeof crypto !== "undefined" &&
        crypto?.subtle &&
        typeof TextEncoder === "function"
    ) {
        try {
            const digest = await crypto.subtle.digest(
                "SHA-256",
                new TextEncoder().encode(value)
            );

            return _bytesToHex(new Uint8Array(digest));
        } catch (error) {
            log.error("hashSHA256 failed", {
                message: error?.message || String(error),
            });

            throw new Error("HASH_UNAVAILABLE");
        }
    }

    throw new Error("WEB_CRYPTO_UNAVAILABLE");
}

// =============================================================================
// BLOQUE 3 - HMAC-SHA256
// =============================================================================

export async function hmacSha256Hex(key, payload) {
    const keyValue = _toString(key);
    const payloadValue = _toString(payload);

    if (!keyValue || !payloadValue) {
        return ZERO_HASH;
    }

    if (
        typeof crypto !== "undefined" &&
        crypto?.subtle &&
        typeof TextEncoder === "function"
    ) {
        try {
            const encoder = new TextEncoder();

            const cryptoKey = await crypto.subtle.importKey(
                "raw",
                encoder.encode(keyValue), {
                    name: "HMAC",
                    hash: "SHA-256",
                },
                false,
                ["sign"]
            );

            const signature = await crypto.subtle.sign(
                "HMAC",
                cryptoKey,
                encoder.encode(payloadValue)
            );

            return _bytesToHex(new Uint8Array(signature));
        } catch (error) {
            log.error("hmacSha256Hex failed", {
                message: error?.message || String(error),
            });

            throw new Error("HMAC_UNAVAILABLE");
        }
    }

    throw new Error("WEB_CRYPTO_UNAVAILABLE");
}

// =============================================================================
// BLOQUE 4 - CADENA DE HASH
// =============================================================================

export async function hashChain(previousHash, payload) {
    const previous = _toString(previousHash) || ZERO_HASH;
    const content = _toString(payload);

    return hashSHA256(`${previous}|${content}`);
}

// =============================================================================
// BLOQUE 5 - COMPARACION TIMING-SAFE
// =============================================================================

export function timingSafeEqual(first, second) {
    const valueA = _toString(first);
    const valueB = _toString(second);

    const maxLength = Math.max(valueA.length, valueB.length);
    let result = valueA.length ^ valueB.length;

    for (let index = 0; index < maxLength; index += 1) {
        const charA = index < valueA.length ? valueA.charCodeAt(index) : 0;
        const charB = index < valueB.length ? valueB.charCodeAt(index) : 0;

        result |= charA ^ charB;
    }

    return result === 0;
}

// =============================================================================
// BLOQUE 6 - GENERACION DE JWT
// =============================================================================

export async function generateJWT(payload, traceId = null) {
    try {
        if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
            throw new Error("INVALID_JWT_PAYLOAD");
        }

        if (JWT.ALGORITHM !== "HS256") {
            throw new Error("UNSUPPORTED_JWT_ALGORITHM");
        }

        const secret = await getSecret(SECRETS.AUTH_JWT_KEY);

        if (!secret) {
            throw new Error("AUTH_JWT_KEY_NOT_FOUND");
        }

        const issuedAt = Math.floor(Date.now() / 1000);
        const expiration =
            issuedAt + Math.floor(Number(JWT.MS_EXPIRACION) / 1000);

        if (!Number.isFinite(expiration) || expiration <= issuedAt) {
            throw new Error("INVALID_JWT_EXPIRATION");
        }

        const header = {
            alg: "HS256",
            typ: "JWT",
        };

        const tokenPayload = {
            ...payload,
            iat: issuedAt,
            exp: expiration,
        };

        const encodedHeader = _base64UrlEncode(JSON.stringify(header));
        const encodedPayload = _base64UrlEncode(
            JSON.stringify(tokenPayload)
        );

        if (!encodedHeader || !encodedPayload) {
            throw new Error("JWT_ENCODING_FAILED");
        }

        const signingInput = `${encodedHeader}.${encodedPayload}`;
        const signature = await hmacSha256Hex(secret, signingInput);

        if (!_isValidHexSignature(signature)) {
            throw new Error("JWT_SIGNATURE_FAILED");
        }

        return `${signingInput}.${signature}`;
    } catch (error) {
        log.error("generateJWT failed", {
            message: error?.message || String(error),
            traceId,
        });

        throw error;
    }
}

// =============================================================================
// BLOQUE 7 - VALIDACION DE JWT
// =============================================================================

export async function verifyJWT(token, traceId = null) {
    try {
        const rawToken = _toString(token);
        const parts = rawToken.split(".");

        if (parts.length !== 3 || parts.some((part) => !part)) {
            return null;
        }

        const header = _parseJson(_base64UrlDecode(parts[0]));
        const payload = _parseJson(_base64UrlDecode(parts[1]));

        if (!header || !payload) {
            return null;
        }

        if (header.alg !== "HS256" || header.typ !== "JWT") {
            return null;
        }

        const secret = await getSecret(SECRETS.AUTH_JWT_KEY);

        if (!secret) {
            throw new Error("AUTH_JWT_KEY_NOT_FOUND");
        }

        const signingInput = `${parts[0]}.${parts[1]}`;
        const expectedSignature = await hmacSha256Hex(
            secret,
            signingInput
        );

        if (
            !_isValidHexSignature(parts[2]) ||
            !_isValidHexSignature(expectedSignature) ||
            !timingSafeEqual(parts[2].toLowerCase(), expectedSignature)
        ) {
            return null;
        }

        const now = Math.floor(Date.now() / 1000);

        if (!Number.isFinite(Number(payload.exp))) {
            return null;
        }

        if (Number(payload.exp) <= now) {
            return null;
        }

        if (
            payload.nbf !== undefined &&
            (!Number.isFinite(Number(payload.nbf)) ||
                Number(payload.nbf) > now)
        ) {
            return null;
        }

        return payload;
    } catch (error) {
        log.error("verifyJWT failed", {
            message: error?.message || String(error),
            traceId,
        });

        return null;
    }
}