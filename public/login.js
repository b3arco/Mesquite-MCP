const form = document.querySelector("#login-form");
const errorEl = document.querySelector("#login-error");

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  errorEl.textContent = "";

  const formData = new FormData(form);

  const response = await fetch("/auth/login", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      username: formData.get("username"),
      password: formData.get("password")
    })
  });

  const data = await response.json();

  if (!response.ok) {
    errorEl.textContent = data.error || "Unable to sign in";
    return;
  }

  window.location.href = "/";
});
