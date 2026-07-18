import type { NextApiRequest, NextApiResponse } from "next";
import fs from "fs";
import path from "path";

const SETTINGS_FILE = path.join(process.cwd(), ".email-settings.json");

function readSettings() {
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      return JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf-8"));
    }
  } catch {}
  return {};
}

function writeSettings(data: Record<string, any>) {
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(data, null, 2), "utf-8");
}

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method === "GET") {
    return res.status(200).json(readSettings());
  }

  if (req.method === "POST") {
    const current = readSettings();
    const updated = { ...current, ...req.body };
    writeSettings(updated);
    return res.status(200).json({ success: true, settings: updated });
  }

  res.status(405).json({ error: "Method not allowed" });
}
