"use client";

import { useCallback, useEffect, useState } from "react";
import { loadRole, saveRole, type Role } from "@/lib/role";

/** Papel de visão da carteira conectada (ADR-025). `null` = ainda não escolheu. */
export function useRole(wallet: string | null) {
  const [role, setRoleState] = useState<Role | null>(null);

  useEffect(() => {
    setRoleState(loadRole(wallet));
  }, [wallet]);

  const setRole = useCallback(
    (next: Role) => {
      if (wallet) saveRole(wallet, next);
      setRoleState(next);
    },
    [wallet]
  );

  return { role, setRole };
}
