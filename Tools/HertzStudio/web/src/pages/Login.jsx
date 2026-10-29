import { useEffect, useRef, useState } from "react";
import gsap from "gsap";
import { ArrowRight } from "lucide-react";
import { api } from "../api.js";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export default function Login({ onLogin }) {
  const [username, setUsername] = useState("kingsley");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [setupRequired, setSetupRequired] = useState(false);
  const stageRef = useRef(null);

  useEffect(() => {
    api("/api/auth/status")
      .then((s) => setSetupRequired(Boolean(s.setupRequired)))
      .catch(() => {});
  }, []);

  useEffect(() => {
    const root = stageRef.current;
    if (!root) return undefined;
    const ctx = gsap.context(() => {
      gsap.from("[data-login-mark]", {
        scale: 1.18,
        opacity: 0,
        duration: 1.1,
        ease: "power3.out",
      });
      gsap.from("[data-login-panel]", {
        y: 36,
        opacity: 0,
        filter: "blur(10px)",
        duration: 0.85,
        delay: 0.2,
        ease: "power3.out",
        clearProps: "filter",
      });
      gsap.from("[data-login-chip]", {
        y: 16,
        opacity: 0,
        duration: 0.6,
        stagger: 0.12,
        delay: 0.45,
        ease: "power2.out",
      });
      gsap.to("[data-login-glow]", {
        opacity: 0.85,
        scale: 1.1,
        duration: 3.4,
        yoyo: true,
        repeat: -1,
        ease: "sine.inOut",
      });
    }, root);
    return () => ctx.revert();
  }, []);

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      if (setupRequired) {
        await api("/api/auth/setup", {
          method: "POST",
          body: JSON.stringify({ password }),
        });
        setSetupRequired(false);
      }
      await api("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({ username, password }),
      });
      const me = await api("/api/auth/me");
      onLogin(me);
    } catch (err) {
      setError(err.message || "Login failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div ref={stageRef} className="studio-stage relative grid min-h-screen place-items-center overflow-hidden px-4">
      <div className="studio-noise" />
      <div
        data-login-glow
        className="pointer-events-none absolute left-1/2 top-[28%] z-0 size-[min(70vw,34rem)] -translate-x-1/2 rounded-full bg-[radial-gradient(circle,rgb(255_107_61_/_0.45),transparent_68%)] blur-2xl"
      />
      <div
        data-login-mark
        className="pointer-events-none absolute left-1/2 top-[36%] z-0 -translate-x-1/2 -translate-y-1/2 text-[clamp(4rem,16vw,11rem)] font-extrabold tracking-[-0.07em] text-transparent [-webkit-text-stroke:1px_rgb(255_255_255_/_0.12)]"
        aria-hidden
      >
        HERTZ
      </div>

      <div className="relative z-[2] flex w-full max-w-md flex-col gap-4">
        <div data-login-chip className="glass-pill mx-auto text-muted-foreground">
          <span className="size-1.5 rounded-full bg-[var(--glow)] shadow-[0_0_10px_var(--glow)]" />
          Private frequency · owner access
        </div>

        <div data-login-panel className="glass-panel p-7 md:p-8">
          <div className="mb-6">
            <div className="eyebrow mb-3">HERTZ Studio</div>
            <h1 className="m-0 text-3xl font-semibold tracking-[-0.04em]">
              Sign in to author the{" "}
              <span className="text-[var(--glow)]">town</span>.
            </h1>
            <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
              {setupRequired
                ? "First-time local setup: choose an owner password (min 10 characters). Prefer HERTZ_OWNER_PASSWORD in the environment for automation. Never stored in the frontend bundle."
                : "Enter your owner password. Hosted mode requires HERTZ_OWNER_PASSWORD — never a browser default."}
            </p>
          </div>

          <form className="space-y-4" onSubmit={submit}>
            <div className="space-y-2">
              <Label htmlFor="user">Username</Label>
              <Input
                id="user"
                className="h-10 rounded-full border-white/10 bg-white/5"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoComplete="username"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="pass">{setupRequired ? "Create password" : "Password"}</Label>
              <Input
                id="pass"
                type="password"
                className="h-10 rounded-full border-white/10 bg-white/5"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete={setupRequired ? "new-password" : "current-password"}
                placeholder=""
              />
            </div>
            {error ? <p className="error">{error}</p> : null}
            <Button className="h-11 w-full gap-2 text-sm font-semibold" disabled={busy} type="submit">
              {busy ? "Working…" : setupRequired ? "Create owner & enter" : "Enter Studio"}
              <ArrowRight className="size-4" />
            </Button>
          </form>
        </div>

        <div data-login-chip className="glass-pill mx-auto text-muted-foreground">
          Drafts stay durable when Unity is offline
        </div>
      </div>
    </div>
  );
}
