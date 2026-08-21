// Session spine suite: the plugin objects, factories and loop entry the
// session kernel mounts on every session context. A host that loads the
// spine dynamically from the distributed tree (staging/resources node_modules)
// injects the suite it loaded, so every mount — boot root, session scopes,
// disk-loaded capability plugins — shares ONE set of spine module identities.
// Hosts that do not inject get the bundled static suite below (the
// pre-distribution behavior, used by every self-contained session and the
// in-repo tests).
import type * as KernelLogger from "@innocencecode/kernel-logger";
import type * as SpineTools from "@innocencecode/harness-tools";
import type * as SpinePermissions from "@innocencecode/harness-permissions";
import type * as SpineProviders from "@innocencecode/harness-providers";
import type * as SpineSkills from "@innocencecode/harness-skills";
import type * as SpineSystemPrompt from "@innocencecode/harness-system-prompt";
import type * as SpineAgents from "@innocencecode/harness-agent";
import type * as SpineSession from "@innocencecode/harness-session";
import type * as SpineLoop from "@innocencecode/harness-agent-loop";
import * as loggerModule from "@innocencecode/kernel-logger";
import * as toolsModule from "@innocencecode/harness-tools";
import * as permissionsModule from "@innocencecode/harness-permissions";
import * as providersModule from "@innocencecode/harness-providers";
import * as skillsModule from "@innocencecode/harness-skills";
import * as systemPromptModule from "@innocencecode/harness-system-prompt";
import * as agentsModule from "@innocencecode/harness-agent";
import * as sessionModule from "@innocencecode/harness-session";
import * as loopModule from "@innocencecode/harness-agent-loop";

/**
 * The mounting face the session kernel consumes, grouped by owning module.
 * Each member is the module's namespace type, so a dynamically loaded module
 * namespace satisfies it structurally and a static import object does too.
 */
export interface SessionSpineSuite {
  readonly logger: typeof KernelLogger;
  readonly tools: typeof SpineTools;
  readonly permissions: typeof SpinePermissions;
  readonly providers: typeof SpineProviders;
  readonly skills: typeof SpineSkills;
  readonly systemPrompt: typeof SpineSystemPrompt;
  readonly agents: typeof SpineAgents;
  readonly session: typeof SpineSession;
  readonly loop: typeof SpineLoop;
}

let memo: SessionSpineSuite | undefined;

/**
 * The bundled static spine (workspace sources; the no-injection default).
 * WARNING: production hosts MUST inject the dynamically loaded spine suite
 * through AgentSessionOptions.spine — the production domain relies on the
 * single-instance invariant (one set of spine module identities per process,
 * shared by the boot root, session scopes, disk-loaded capability plugins and
 * spawned child sessions). This static default serves only self-contained
 * sessions and in-repo tests; converging the dual-source static face itself
 * is phase-2 scope.
 */
export function staticSpineSuite(): SessionSpineSuite {
  memo ??= {
    logger: loggerModule,
    tools: toolsModule,
    permissions: permissionsModule,
    providers: providersModule,
    skills: skillsModule,
    systemPrompt: systemPromptModule,
    agents: agentsModule,
    session: sessionModule,
    loop: loopModule,
  };
  return memo;
}
