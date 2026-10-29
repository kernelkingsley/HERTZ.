import { useEffect, useRef } from "react";
import gsap from "gsap";

/**
 * Staggered premium entrance for page content.
 * Prefer data-reveal attributes on children for finer control.
 */
export function useReveal(deps = []) {
  const rootRef = useRef(null);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return undefined;

    const targets = root.querySelectorAll("[data-reveal]");
    const nodes = targets.length ? Array.from(targets) : [root];

    const ctx = gsap.context(() => {
      gsap.fromTo(
        nodes,
        { opacity: 0, y: 22, filter: "blur(6px)" },
        {
          opacity: 1,
          y: 0,
          filter: "blur(0px)",
          duration: 0.7,
          stagger: 0.07,
          ease: "power3.out",
          clearProps: "filter",
        },
      );
    }, root);

    return () => ctx.revert();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return rootRef;
}

/** Soft ambient pulse on glow orbs */
export function useGlowPulse(selector = "[data-glow]") {
  const rootRef = useRef(null);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return undefined;
    const orbs = root.querySelectorAll(selector);
    if (!orbs.length) return undefined;

    const ctx = gsap.context(() => {
      gsap.to(orbs, {
        opacity: 0.55,
        scale: 1.08,
        duration: 3.2,
        yoyo: true,
        repeat: -1,
        ease: "sine.inOut",
        stagger: 0.4,
      });
    }, root);

    return () => ctx.revert();
  }, [selector]);

  return rootRef;
}

/** Float yoyo for glass chips / status pills */
export function useFloat(selector = "[data-float]") {
  const rootRef = useRef(null);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return undefined;
    const items = root.querySelectorAll(selector);
    if (!items.length) return undefined;

    const ctx = gsap.context(() => {
      items.forEach((el, i) => {
        gsap.to(el, {
          y: i % 2 === 0 ? -6 : -10,
          duration: 2.4 + i * 0.25,
          yoyo: true,
          repeat: -1,
          ease: "sine.inOut",
          delay: i * 0.15,
        });
      });
    }, root);

    return () => ctx.revert();
  }, [selector]);

  return rootRef;
}

/** Reveal + optional float on one root */
export function usePremiumPage(deps = []) {
  const rootRef = useRef(null);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return undefined;

    const targets = root.querySelectorAll("[data-reveal]");
    const nodes = targets.length ? Array.from(targets) : [root];
    const floats = root.querySelectorAll("[data-float]");

    const ctx = gsap.context(() => {
      gsap.fromTo(
        nodes,
        { opacity: 0, y: 22, filter: "blur(6px)" },
        {
          opacity: 1,
          y: 0,
          filter: "blur(0px)",
          duration: 0.7,
          stagger: 0.07,
          ease: "power3.out",
          clearProps: "filter",
        },
      );
      floats.forEach((el, i) => {
        gsap.to(el, {
          y: i % 2 === 0 ? -6 : -10,
          duration: 2.4 + i * 0.25,
          yoyo: true,
          repeat: -1,
          ease: "sine.inOut",
          delay: 0.8 + i * 0.15,
        });
      });
    }, root);

    return () => ctx.revert();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return rootRef;
}
