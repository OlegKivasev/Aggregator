export function createCartToast(container) {
  const toast = document.createElement("div");
  toast.className = "cart-toast";
  toast.hidden = true;
  toast.setAttribute("role", "status");
  toast.setAttribute("aria-live", "polite");
  container.append(toast);
  let timeout;
  return (message, error = false) => {
    clearTimeout(timeout);
    toast.textContent = message;
    toast.classList.toggle("is-error", error);
    toast.hidden = !message;
    if (message) timeout = setTimeout(() => { toast.hidden = true; }, 4000);
  };
}
