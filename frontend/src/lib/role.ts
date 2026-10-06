/**
 * Papel de VISÃO (ADR-025): escolhe o que a UI exibe. Não autoriza nada — toda checagem
 * continua on-chain e no backend (INV-8). Lógica pura, sem React nem web3, para ser testável.
 */

export type Role = "company" | "researcher";
export type RoleView = "mine" | "open" | "arbiter";

/** O mínimo que a visão precisa de um job (compatível com `JobView`). */
export interface RoleJob {
  client: string;
  researcher: string | null;
  arbiter: string;
  status: string;
}

const KEY_PREFIX = "proofsec:role:";

export function isRole(v: unknown): v is Role {
  return v === "company" || v === "researcher";
}

/** Preferência de visão por carteira; `localStorage` pode falhar (modo privado, bloqueio). */
export function loadRole(wallet: string | null, storage: Pick<Storage, "getItem"> | undefined = safeStorage()): Role | null {
  if (!wallet || !storage) return null;
  try {
    const v = storage.getItem(KEY_PREFIX + wallet);
    return isRole(v) ? v : null;
  } catch {
    return null;
  }
}

export function saveRole(wallet: string, role: Role, storage: Pick<Storage, "setItem"> | undefined = safeStorage()): void {
  if (!storage) return;
  try {
    storage.setItem(KEY_PREFIX + wallet, role);
  } catch {
    /* só preferência de visão: seguir sem persistir */
  }
}

function safeStorage(): Storage | undefined {
  try {
    return typeof window === "undefined" ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}

/** Carteira é árbitro de algum job? Habilita a visão de árbitro, independente do papel. */
export function isArbiterAnywhere(jobs: RoleJob[], wallet: string | null): boolean {
  return !!wallet && jobs.some((j) => j.arbiter === wallet && j.client !== wallet);
}

/** Visões disponíveis para o papel (a de árbitro só aparece se a carteira for árbitro de algum job). */
export function viewsFor(role: Role, arbiter: boolean): RoleView[] {
  const base: RoleView[] = role === "company" ? ["mine"] : ["open", "mine"];
  return arbiter ? [...base, "arbiter"] : base;
}

export function defaultView(role: Role): RoleView {
  return role === "company" ? "mine" : "open";
}

/** Filtra a lista para o papel e a visão. Sem carteira não há papel: mostra tudo (modo leitura). */
export function jobsForRoleView<T extends RoleJob>(jobs: T[], role: Role, view: RoleView, wallet: string | null): T[] {
  if (!wallet) return jobs;
  switch (view) {
    case "mine":
      // Empresa: escrows que criei. Pesquisador: onde fui atribuído.
      return jobs.filter((j) => (role === "company" ? j.client === wallet : j.researcher === wallet));
    case "open":
      return jobs.filter((j) => j.status === "OPEN" && !j.researcher && j.client !== wallet);
    case "arbiter":
      return jobs.filter((j) => j.arbiter === wallet && j.client !== wallet);
  }
}

/** O que o painel lateral mostra: só a Empresa cria escrows e configura o agente. */
export function canCreateEscrow(role: Role | null): boolean {
  return role === "company";
}
export function canConfigureAgent(role: Role | null): boolean {
  return role === "company";
}

export const ROLE_LABEL: Record<Role, string> = { company: "Empresa", researcher: "Pesquisador" };
export const VIEW_LABEL: Record<RoleView, Record<Role, string>> = {
  mine: { company: "Meus escrows", researcher: "Meus trabalhos" },
  open: { company: "Vagas abertas", researcher: "Vagas abertas" },
  arbiter: { company: "Disputas (árbitro)", researcher: "Disputas (árbitro)" },
};
