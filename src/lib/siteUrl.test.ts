import test from "node:test";
import assert from "node:assert/strict";
import { resolveSiteUrl, PRODUCTION_SITE_URL } from "./siteUrl.ts";

test("defaults to the production dashboard URL", () => {
  assert.equal(resolveSiteUrl({}), PRODUCTION_SITE_URL);
});

test("a localhost override is ignored on the production deployment", () => {
  assert.equal(resolveSiteUrl({ NEXT_PUBLIC_SITE_URL: "http://localhost:3000", VERCEL_ENV: "production" }), PRODUCTION_SITE_URL);
  assert.equal(resolveSiteUrl({ NEXT_PUBLIC_SITE_URL: "http://127.0.0.1:3000", VERCEL_ENV: "production" }), PRODUCTION_SITE_URL);
});

test("a localhost override still works locally, and a real custom domain is honoured in production", () => {
  assert.equal(resolveSiteUrl({ NEXT_PUBLIC_SITE_URL: "http://localhost:3000" }), "http://localhost:3000");
  assert.equal(resolveSiteUrl({ NEXT_PUBLIC_SITE_URL: "https://app.example.com", VERCEL_ENV: "production" }), "https://app.example.com");
});
