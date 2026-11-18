# Signed hand-offs

A signed hand-off is a folder that lets the person who receives a session hand-off check two things: that no byte changed after it was signed, and that it was signed by the sender's key. It follows ADR-9 of the design: a raw Ed25519 signature over a manifest in RFC 8785 canonical JSON (JCS), with the key fingerprint passed out of band. The format is open, and checking a bundle needs either `ledger verify` or OpenSSL 3 alone.

Signing does not redact anything. The bundle holds the same Markdown as `npm run ledger -- handoff <session-id>`, so read it before you send it. The secret scanner and the redaction diff are card P4b.

## For the sender

1. Create a signing key once:

   ```sh
   npm run ledger -- keygen
   ```

   It prints the key's fingerprint and nothing else, for example `fd78 8b7d 761e ... 5d10` (16 groups of 4 hex digits). The private key is saved as `signing-key.pem` beside the ledger database: in `.context-ledger/` by default, or in the folder of `CONTEXT_LEDGER_DB` when that is set. `keygen` never replaces an existing key.

   - On Linux and macOS the key file is created with mode 0600, and signing refuses a key file that other users can read.
   - On Windows the file has no POSIX mode. It takes the access list of its folder, which for a folder in your user profile normally means only you (and administrators) can read it. Keep the ledger data folder out of shared or synced folders.
   - The key is not encrypted with a passphrase yet (design section 6; card P4b). Anyone who can read the file can sign as you, so back it up like any other private key.

2. Give the fingerprint to the people who will receive your hand-offs through a channel other than the bundle itself: in person, on a call, or in a message they already trust. The fingerprint is what proves the bundle came from you; the key inside the bundle cannot prove that on its own.

3. With the ledger running (`npm start`), sign a hand-off into a new folder:

   ```sh
   npm run ledger -- handoff <session-id> --sign <new-folder>
   ```

   The folder must not exist yet; nothing is ever overwritten. Send the whole folder (for example as a zip).

## What is in the folder

| File | What it is |
| --- | --- |
| `handoff.md` | The hand-off Markdown, byte for byte what `ledger handoff <session-id>` prints. |
| `manifest.json` | RFC 8785 canonical JSON, with no trailing newline: `format` (`context-ledger-signed-handoff`), `version` (1), `algorithm` (`Ed25519`), `created_at` (UTC, milliseconds), `session`, `public_key` (base64 of the key's SubjectPublicKeyInfo DER bytes) and `files`, which lists the name, byte size and SHA-256 of every content file (today only `handoff.md`). |
| `manifest.sig` | The 64-byte raw Ed25519 signature over the exact bytes of `manifest.json`. |
| `public-key.pem` | The same public key as `public_key`, as PEM, for OpenSSL. |

The fingerprint is the SHA-256 of the public key's SubjectPublicKeyInfo DER bytes (44 bytes for Ed25519), in hex. Spaces, colons and letter case do not matter when you compare it.

## For the receiver, with the ledger

```sh
npm run ledger -- verify <folder> --fingerprint "<fingerprint from the sender>"
```

It exits 0 only when every check passes: the manifest is canonical JCS in the expected format, the signature matches the manifest, the key matches the fingerprint, `public-key.pem` matches the manifest key, every listed file has its listed size and hash, and the folder holds no other file or subfolder. Otherwise it prints what failed and exits 1. Without `--fingerprint` it still checks everything else, but warns that the key was not checked: anyone can make a bundle that is consistent with a key of their own.

## For the receiver, with OpenSSL only

You need OpenSSL 3.0 or later (`openssl version`). On Windows, Git for Windows includes it in Git Bash. On macOS, `/usr/bin/openssl` is LibreSSL, which may not verify Ed25519 this way; install OpenSSL 3 (for example `brew install openssl@3`). Run these from inside the bundle folder:

<!-- openssl-recipe -->
```sh
openssl pkey -pubin -in public-key.pem -outform DER | openssl dgst -sha256
openssl pkeyutl -verify -pubin -inkey public-key.pem -rawin -in manifest.json -sigfile manifest.sig
openssl dgst -sha256 handoff.md
```

1. The first command prints the key fingerprint (for example `SHA2-256(stdin)= fd788b7d...`). It must equal the fingerprint the sender gave you, ignoring spaces. If it does not, stop: the bundle was not signed by that sender.
2. The second must print `Signature Verified Successfully`. It proves that `manifest.json` is exactly what the key holder signed.
3. The third prints the SHA-256 of `handoff.md`. It must equal the `sha256` given for `handoff.md` in the `files` list of `manifest.json`. Do the same for any other file the list names.
4. Open `manifest.json` in a text editor and check that the folder holds no file other than the ones in `files` and the three envelope files (`manifest.json`, `manifest.sig`, `public-key.pem`). A file that is not listed is not covered by the signature.

OpenSSL does not check that `manifest.json` is canonical JCS. That check protects tools that parse the manifest, not the signature: the signature already covers its exact bytes.

`tests/sign.test.mjs` runs the three commands in the block above against a freshly signed bundle whenever `openssl` is on PATH, and checks that they refuse a manifest with one changed byte.
