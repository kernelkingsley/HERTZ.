import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, fireEvent } from "@testing-library/react";
import ImageLightbox from "./ImageLightbox.jsx";

describe("ImageLightbox", () => {
  afterEach(() => cleanup());

  it("renders image and closes on Escape", () => {
    const onClose = vi.fn();
    render(<ImageLightbox open src="/portrait.png" alt="Portrait" onClose={onClose} />);
    expect(screen.getByTestId("lightbox-image")).toHaveAttribute("src", "/portrait.png");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });

  it("shows load-error fallback", () => {
    render(<ImageLightbox open src="/broken.png" alt="Broken" onClose={() => {}} />);
    fireEvent.error(screen.getByTestId("lightbox-image"));
    expect(screen.getByTestId("lightbox-error")).toBeInTheDocument();
  });

  it("exposes Open original when verified URL provided", () => {
    render(
      <ImageLightbox
        open
        src="/landscape.png"
        alt="Landscape"
        originalUrl="https://example.com/full.png"
        onClose={() => {}}
      />,
    );
    expect(screen.getByTestId("lightbox-open-original")).toHaveAttribute("href", "https://example.com/full.png");
  });
});
