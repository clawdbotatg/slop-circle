import type { WindowApp } from "@commons/app-kit";

// The SKILL — a markdown brief that turns "here's a circle" into "an agent can
// operate this circle." The base composes it from the installed apps' own
// `skill` sections plus how to join.
//
// Unlike slop.computer (whose relay sees content, so it mints a server-side
// agent token), circle's relay is BLIND — it can't grant an agent the ability
// to read the room. So the credential is the invite link itself: its URL
// fragment carries the room secret, which never touches the server. Compose
// the skill client-side, hand it (link included) to an agent, and the agent
// operates the circle by driving the client — end-to-end encryption intact.

export function composeSkill(opts: { apps: Pick<WindowApp, "label" | "skill">[]; inviteUrl: string }): string {
  const appLines = opts.apps
    .filter(a => a.skill)
    .map(a => `- **${a.label}** — ${a.skill}`)
    .join("\n");

  return `# Operating this circle

circle is a private, end-to-end-encrypted room: video / audio / screen calls
and a set of apps gathered around a shared wallet. Everything is peer-to-peer;
the server only relays ciphertext and cannot read the room.

## Join
Open this link in a browser (it carries the room + secret in the URL fragment
after \`#\`, which never reaches the server). Keep it private — anyone with it
can enter:

    ${opts.inviteUrl}

Pick a display name, allow camera + mic, and you're in the room.

## Apps in this room
${appLines || "- (none registered)"}

## For an agent operating this room
- The room secret lives in the fragment of the link above; treat it as private.
- Media and all app messages are end-to-end encrypted — only members in the
  room can read them; the relay only ever sees ciphertext.
- Act by driving the client: open the link, use the menu-bar launchers to open
  apps, and interact through their windows.
`;
}
