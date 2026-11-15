import { asana } from "./asana";
import { clickup } from "./clickup";
import { confluence } from "./confluence";
import { fireflies } from "./fireflies";
import { github } from "./github";
import { gitlab } from "./gitlab";
import { gmail } from "./gmail";
import { googleCalendar, googleSheets } from "./google";
import { googleDrive } from "./google-drive";
import { hubspot } from "./hubspot";
import { imap } from "./imap";
import { jira } from "./jira";
import { linear } from "./linear";
import { outlookCalendar } from "./microsoft";
import { notion } from "./notion";
import { outlook } from "./outlook";
import type { Provider } from "./provider";
import { slack } from "./slack";
import { teams } from "./teams";
import { zendesk } from "./zendesk";

/** Every source ALRO connects to directly. To add one, see .claude/skills/build-connector. */
const ALL: Provider[] = [slack, teams, gmail, outlook, imap, notion, confluence, googleDrive, jira, linear, github, gitlab, asana, clickup, zendesk, fireflies, googleCalendar, outlookCalendar, googleSheets, hubspot];

export const PROVIDERS: ReadonlyMap<string, Provider> = new Map(ALL.map((p) => [p.id, p]));

export const providerOf = (id: string): Provider | undefined => PROVIDERS.get(id);
