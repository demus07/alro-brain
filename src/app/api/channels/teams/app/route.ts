import { deflateSync } from "node:zlib";
import { zipSync, strToU8 } from "fflate";
import { connection } from "next/server";
import { teamsBotConfigured } from "@/channels/teams-bot";
import { getViewer } from "@/lib/viewer";

/**
 * The Teams app package for this deployment's bot: a manifest and two icons, zipped.
 * Upload it in Teams (Apps → Manage your apps → Upload an app) or in the Teams admin centre.
 */
export async function GET(request: Request) {
  await connection();
  await getViewer();
  if (!teamsBotConfigured()) return Response.json({ error: "The Teams bot isn't set up on this server" }, { status: 400 });
  const site = (process.env.ALRO_APP_URL ?? new URL(request.url).origin).replace(/\/$/, "");
  const botId = process.env.MICROSOFT_BOT_APP_ID!;
  const manifest = {
    $schema: "https://developer.microsoft.com/json-schemas/teams/v1.19/MicrosoftTeams.schema.json",
    manifestVersion: "1.19",
    version: "1.0.0",
    id: botId,
    developer: { name: "ALRO", websiteUrl: site, privacyUrl: `${site}/settings`, termsOfUseUrl: `${site}/settings` },
    name: { short: "ALRO", full: "ALRO company brain" },
    description: {
      short: "Ask your company brain, approve its work.",
      full: "Ask ALRO about anything said, decided or promised across your company's chats, email and meetings, send it photos and documents, and approve what it drafts before anything goes out.",
    },
    icons: { color: "color.png", outline: "outline.png" },
    accentColor: "#205EA6",
    bots: [{ botId, scopes: ["personal"], supportsFiles: true, isNotificationOnly: false }],
    permissions: ["identity", "messageTeamMembers"],
    validDomains: [new URL(site).host],
  };
  const zip = zipSync({
    "manifest.json": strToU8(JSON.stringify(manifest, null, 2)),
    "color.png": png(192, [0x20, 0x5e, 0xa6, 0xff]),
    "outline.png": png(32, [0xff, 0xff, 0xff, 0xff], true),
  });
  return new Response(new Uint8Array(zip), { headers: { "content-type": "application/zip", "content-disposition": 'attachment; filename="alro-teams-app.zip"' } });
}

/** A square icon: a filled circle on a transparent background. */
function png(size: number, rgba: number[], outline = false): Uint8Array {
  const rows: number[] = [];
  const r = size / 2;
  for (let y = 0; y < size; y++) {
    rows.push(0);
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x + 0.5 - r, y + 0.5 - r);
      const inside = outline ? d < r - 1 && d > r - 4 : d < r;
      rows.push(...(inside ? rgba : [0, 0, 0, 0]));
    }
  }
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc32(body), 8 + data.length);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 6;
  return new Uint8Array(
    Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(Buffer.from(rows))), chunk("IEND", Buffer.alloc(0))]),
  );
}

function crc32(buf: Buffer): number {
  let c = ~0;
  for (const byte of buf) {
    c ^= byte;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
  }
  return ~c >>> 0;
}
