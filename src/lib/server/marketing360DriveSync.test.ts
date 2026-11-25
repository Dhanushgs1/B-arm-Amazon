import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, createVerify } from "node:crypto";

test("service account JWT is RS256-signed with the Drive read-only scope", async () => {
  const { signedAssertion } = await import("./marketing360DriveSync.ts");
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const jwt = signedAssertion({ client_email: "sync@example.iam.gserviceaccount.com", private_key: pem }, 1_000);
  const [h, c, s] = jwt.split(".");
  assert.deepEqual(JSON.parse(Buffer.from(h, "base64url").toString()), { alg: "RS256", typ: "JWT" });
  const claims = JSON.parse(Buffer.from(c, "base64url").toString());
  assert.equal(claims.scope, "https://www.googleapis.com/auth/drive.readonly");
  assert.equal(claims.exp - claims.iat, 3600);
  const v = createVerify("RSA-SHA256"); v.update(`${h}.${c}`);
  assert.equal(v.verify(publicKey, Buffer.from(s, "base64url")), true);
});
