const status = document.querySelector("#copy-status");

document.querySelectorAll("[data-copy-target]").forEach((button) => {
  button.addEventListener("click", async () => {
    const source = document.getElementById(button.dataset.copyTarget);
    if (!source) return;

    try {
      await navigator.clipboard.writeText(source.textContent.trim());
      button.textContent = "Copied";
      status.textContent = "Install command copied to clipboard.";
      window.setTimeout(() => {
        button.textContent = "Copy";
        status.textContent = "";
      }, 1800);
    } catch {
      status.textContent = "Copy failed. Select the command and copy it manually.";
    }
  });
});

document.querySelector("#year").textContent = new Date().getFullYear();
