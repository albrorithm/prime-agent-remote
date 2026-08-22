import { describe, expect, it } from "vitest";
import { latexToUnicode } from "./latex";

describe("latexToUnicode", () => {
  it("converts symbols, big operators, and scripts", () => {
    expect(latexToUnicode("y_t = \\sum_{k=0}^{W-1} w_k \\odot x_{t-k}"))
      .toBe("yₜ = ∑ₖ₌₀ᵂ⁻¹ wₖ ⊙ xₜ₋ₖ");
  });

  it("converts Greek letters and relations", () => {
    expect(latexToUnicode("\\alpha \\leq \\beta \\implies \\gamma \\to \\infty"))
      .toBe("α ≤ β ⇒ γ → ∞");
  });

  it("renders operator names as plain words", () => {
    expect(latexToUnicode("O(n \\log n)")).toBe("O(n log n)");
    expect(latexToUnicode("\\max_i f(x_i)")).toBe("maxᵢ f(xᵢ)");
  });

  it("renders fractions linearly with parentheses only when needed", () => {
    expect(latexToUnicode("\\frac{a}{b}")).toBe("a/b");
    expect(latexToUnicode("\\frac{x+1}{2}")).toBe("(x+1)/2");
    expect(latexToUnicode("\\frac{1}{2} m v^2")).toBe("½ m v²");
  });

  it("renders square roots", () => {
    expect(latexToUnicode("\\sqrt{x}")).toBe("√x");
    expect(latexToUnicode("\\sqrt{x^2+1}")).toBe("√(x²+1)");
    expect(latexToUnicode("\\sqrt[3]{8}")).toBe("∛8");
  });

  it("unwraps text commands and styles alphabets", () => {
    expect(latexToUnicode("\\text{softmax}(QK^T / \\sqrt{d_k})")).toBe("softmax(QKᵀ / √dₖ)");
    expect(latexToUnicode("\\mathbb{R}^d")).toBe("ℝᵈ");
    expect(latexToUnicode("\\mathcal{L}")).toBe("ℒ");
    expect(latexToUnicode("\\mathbf{W} x")).toBe("𝐖 x");
  });

  it("applies accents as combining characters", () => {
    expect(latexToUnicode("\\hat{y}")).toBe("ŷ");
    expect(latexToUnicode("\\vec{x}")).toBe("x⃗");
  });

  it("keeps TeX notation for scripts without Unicode forms", () => {
    expect(latexToUnicode("\\nabla_\\theta J(\\theta)")).toBe("∇_θ J(θ)");
    expect(latexToUnicode("x_{best}")).toBe("x_{best}");
  });

  it("drops sizing commands and keeps delimiters", () => {
    expect(latexToUnicode("\\left( \\frac{1}{N} \\sum_{i=1}^N x_i \\right)"))
      .toBe("( 1/N ∑ᵢ₌₁ᴺ xᵢ )");
  });

  it("turns aligned environments into multiple lines", () => {
    expect(latexToUnicode("\\begin{aligned} a &= b + c \\\\ d &= e \\end{aligned}").trim())
      .toBe("a = b + c \n d = e");
  });

  it("degrades unknown commands to their names", () => {
    expect(latexToUnicode("\\foobar x")).toBe("foobar x");
  });

  it("handles escaped braces", () => {
    expect(latexToUnicode("x \\in \\{1, \\dots, K\\}")).toBe("x ∈ {1, …, K}");
  });

  it("collapses insignificant whitespace from spacing commands", () => {
    expect(latexToUnicode("\\int_0^1 x^2 \\, dx = \\frac{1}{3}")).toBe("∫₀¹ x² dx = ⅓");
  });

  it("renders matrix environments as rows", () => {
    expect(latexToUnicode("\\begin{pmatrix}\n1 & 2 \\\\\n3 & 4\n\\end{pmatrix}").trim())
      .toBe("1 2 \n3 4");
  });

  it("treats accented characters as simple fraction operands", () => {
    expect(latexToUnicode("\\frac{\\hat{x}}{2}")).toBe("x̂/2");
  });

  it("keeps underscores literal inside text-mode commands", () => {
    expect(latexToUnicode("\\text{x_i}")).toBe("x_i");
    expect(latexToUnicode("\\text{learning_rate} = 0.1")).toBe("learning_rate = 0.1");
    expect(latexToUnicode("\\mathrm{x_i}")).toBe("xᵢ");
  });
});
