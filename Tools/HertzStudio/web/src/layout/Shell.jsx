import { useEffect, useRef } from "react";
import { NavLink } from "react-router-dom";
import gsap from "gsap";
import {
  Cable,
  LayoutDashboard,
  LogOut,
  Map,
  Rocket,
  Sparkles,
} from "lucide-react";
import { api } from "../api.js";
import { getMilestoneStatus } from "../lib/milestoneStatus.js";
import TargetSceneControl from "../components/TargetSceneControl.jsx";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

function buildNav() {
  return [
    {
      group: "Main",
      items: [
        { to: "/", label: "Dashboard", end: true, icon: LayoutDashboard },
        { to: "/milestones", label: "Milestones", badge: getMilestoneStatus("W03") },
      ],
    },
    {
      group: "Make",
      items: [
        { to: "/level-editor", label: "Level editor", icon: Map, badge: getMilestoneStatus("W03") },
        { to: "/characters", label: "Characters & Enemies", badge: getMilestoneStatus("W05") },
        { to: "/weapons", label: "Weapons", badge: getMilestoneStatus("W04") },
        { to: "/avatar-previews", label: "Avatar previews" },
      ],
    },
    {
      group: "Assets",
      items: [
        { to: "/assets", label: "Asset Library", badge: getMilestoneStatus("W02") },
        { to: "/find", label: "Find Assets" },
        { to: "/sound", label: "Sound", badge: getMilestoneStatus("W07") },
        { to: "/materials", label: "Materials & Lighting", badge: getMilestoneStatus("W08") },
        { to: "/animation", label: "Animation", badge: getMilestoneStatus("W09") },
      ],
    },
    {
      group: "Inspect",
      items: [
        { to: "/analytics", label: "Analytics", badge: getMilestoneStatus("W06") },
        { to: "/performance", label: "Performance", badge: getMilestoneStatus("W10") },
        { to: "/snapshots", label: "Snapshots", badge: getMilestoneStatus("W11") },
        { to: "/encounters", label: "Encounters", badge: getMilestoneStatus("W12") },
      ],
    },
    {
      group: "Ship",
      items: [{ to: "/deploy", label: "Deploy", badge: getMilestoneStatus("W14"), icon: Rocket }],
    },
  ];
}

export default function Shell({ user, onLogout, children }) {
  const shellRef = useRef(null);
  // Badges re-read shared gates on each App render (gatesTick). Do not key-remount Shell — that wiped Level Editor draft state.
  const NAV = buildNav();

  useEffect(() => {
    const root = shellRef.current;
    if (!root) return undefined;
    const ctx = gsap.context(() => {
      gsap.from("[data-shell-aside]", {
        x: -28,
        opacity: 0,
        duration: 0.85,
        ease: "power3.out",
      });
      gsap.from("[data-shell-main]", {
        opacity: 0,
        duration: 0.6,
        delay: 0.15,
        ease: "power2.out",
      });
      gsap.to("[data-shell-glow]", {
        opacity: 0.5,
        scale: 1.12,
        duration: 3.6,
        yoyo: true,
        repeat: -1,
        ease: "sine.inOut",
      });
    }, root);
    return () => ctx.revert();
  }, []);

  async function logout() {
    await api("/api/auth/logout", { method: "POST", body: "{}" });
    onLogout();
  }

  return (
    <div ref={shellRef} className="studio-stage relative grid min-h-screen lg:grid-cols-[16.5rem_1fr]">
      <div className="studio-noise" />
      <div
        data-shell-glow
        className="pointer-events-none absolute left-[18%] top-[-8%] z-0 size-[28rem] rounded-full bg-[radial-gradient(circle,rgb(255_107_61_/_0.28),transparent_70%)] blur-2xl"
      />

      <aside
        data-shell-aside
        className="relative z-[2] m-3 flex flex-col gap-4 rounded-[1.35rem] border border-white/10 bg-[rgb(10_12_16_/_0.72)] p-3 text-sidebar-foreground shadow-[0_24px_80px_rgb(0_0_0_/_0.45)] backdrop-blur-2xl lg:m-4 lg:mr-0"
      >
        <div className="flex items-center gap-3 px-2 pt-1">
          <div className="grid size-10 place-items-center rounded-2xl bg-primary font-extrabold tracking-tight text-primary-foreground shadow-[0_0_32px_rgb(233_246_90_/_0.35)]">
            Hz
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-1.5 text-xs font-semibold tracking-[0.12em]">
              HERTZ
              <Sparkles className="size-3 text-[var(--glow)]" />
            </div>
            <div className="truncate text-[11px] text-muted-foreground">studio.hertz.software</div>
          </div>
        </div>

        <nav className="flex flex-1 flex-col gap-4 overflow-y-auto px-1 pb-2">
          {NAV.map((section) => (
            <div key={section.group} className="space-y-1">
              <div className="px-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground/80">
                {section.group}
              </div>
              {section.items.map((item) => {
                const Icon = item.icon;
                return (
                  <NavLink
                    key={item.to}
                    to={item.to}
                    end={item.end}
                    className={({ isActive }) =>
                      cn(
                        "group flex items-center justify-between gap-2 rounded-full px-3 py-2 text-sm transition-all duration-300",
                        isActive
                          ? "bg-white/10 text-foreground shadow-[inset_0_0_0_1px_rgb(255_255_255_/_0.08)]"
                          : "text-muted-foreground hover:bg-white/5 hover:text-foreground",
                      )
                    }
                  >
                    <span className="flex items-center gap-2">
                      {Icon ? <Icon className="size-3.5 opacity-80 transition-transform group-hover:scale-110" /> : null}
                      {item.label}
                    </span>
                    {item.badge ? (
                      <Badge
                        variant="outline"
                        className="rounded-full border-[var(--glow)]/40 text-[10px] text-[var(--glow)]"
                      >
                        {item.badge}
                      </Badge>
                    ) : null}
                  </NavLink>
                );
              })}
            </div>
          ))}
        </nav>

        <TargetSceneControl />

        <div className="mt-auto space-y-2 border-t border-white/8 px-1 pt-3">
          <NavLink
            to="/connections"
            className={({ isActive }) =>
              cn(
                "flex items-center gap-2 rounded-full px-3 py-2 text-sm transition-colors",
                isActive ? "bg-white/10 text-foreground" : "text-muted-foreground hover:bg-white/5 hover:text-foreground",
              )
            }
          >
            <Cable className="size-3.5" />
            <span className="inline-flex items-center gap-2">
              <span className="size-1.5 rounded-full bg-[var(--ok)] shadow-[0_0_10px_var(--ok)]" />
              Connections
            </span>
          </NavLink>
          <Button
            variant="outline"
            className="w-full justify-start gap-2 border-white/10 bg-white/5 hover:bg-white/10"
            onClick={logout}
          >
            <LogOut className="size-3.5" />
            Sign out ({user.username})
          </Button>
        </div>
      </aside>

      <main data-shell-main className="relative z-[2] min-w-0 p-4 md:p-6 lg:p-8">
        <div className="studio-watermark" aria-hidden>
          HERTZ
        </div>
        <div className="relative z-[1]">{children}</div>
      </main>
    </div>
  );
}
