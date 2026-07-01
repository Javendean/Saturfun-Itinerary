// Saturfun app shell: injects the bottom tab bar, marks the active tab,
// registers the unified root service worker, and migrates off the old wall SW.
(function () {
  var TABS = [
    { id: "trip",   label: "Trip",   icon: "🗺️", href: "index.html",  match: ["index.html", ""] },
    { id: "wall",   label: "Wall",   icon: "🖼️", href: "wall.html",   match: ["wall.html"] },
    { id: "panels", label: "Panels", icon: "🎴", href: "manga.html",  match: ["manga.html", "panels.html"] },
    { id: "plan",   label: "Plan",   icon: "✨", href: "plan.html",   match: ["plan.html"] },
  ];
  function currentFile() {
    var p = location.pathname.split("/").pop() || "";
    return p;
  }
  function build() {
    if (document.getElementById("app-tabbar")) return;
    var cur = currentFile();
    var nav = document.createElement("nav");
    nav.id = "app-tabbar";
    nav.setAttribute("aria-label", "Saturfun sections");
    nav.innerHTML = TABS.map(function (t) {
      var active = t.match.indexOf(cur) !== -1;
      return '<a href="' + t.href + '"' + (active ? ' aria-current="page"' : "") + '>' +
        '<span class="ti" aria-hidden="true">' + t.icon + '</span>' +
        '<span class="tl">' + t.label + '</span>' +
        (t.id === "plan" ? '<span class="badge" id="tab-plan-badge" hidden></span>' : "") +
        '</a>';
    }).join("");
    document.body.appendChild(nav);
    document.body.classList.add("has-tabbar");
  }
  window.saturfunSetPlanBadge = function (on) { var b = document.getElementById("tab-plan-badge"); if (b) b.hidden = !on; };
  function registerSW() {
    if (!("serviceWorker" in navigator)) return;
    // Migrate: unregister the old wall-scoped SW so the unified root SW takes over.
    navigator.serviceWorker.getRegistrations().then(function (regs) {
      regs.forEach(function (r) {
        var w = r.active || r.waiting || r.installing;
        var u = w ? w.scriptURL : "";
        if (u.indexOf("/wall-sw.js") !== -1 || /(^|\/)wall-sw\.js$/.test(u)) r.unregister();
      });
    }).catch(function () {});
    navigator.serviceWorker.register("sw.js").catch(function (e) { console.warn("[shell] SW register failed:", e); });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", build);
  else build();
  registerSW();
})();
