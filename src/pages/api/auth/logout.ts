import type { NextApiRequest, NextApiResponse } from "next";
import { clearedSessionCookie } from "@/lib/apiAuth";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  res.setHeader("Set-Cookie", clearedSessionCookie());
  return res.status(200).json({ success: true });
}
