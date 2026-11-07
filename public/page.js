// Language tabs for the static pages (how / legal / privacy / abuse).
// Both languages are in the HTML; this only shows one at a time and remembers the choice.
// Without JS the page still works: both sections are visible and the tabs scroll to them.
(function () {
  const tabs = [...document.querySelectorAll(".langs a")];
  const sections = tabs.map((a) => document.getElementById(a.getAttribute("href").slice(1))).filter(Boolean);
  if (tabs.length < 2 || sections.length !== tabs.length) return;
  const known = tabs.map((a) => a.getAttribute("href").slice(1));

  function pick(lang, remember) {
    if (!known.includes(lang)) lang = known[0];
    sections.forEach((s) => { s.hidden = s.id !== lang; });
    tabs.forEach((a) => {
      if (a.getAttribute("href") === "#" + lang) a.setAttribute("aria-current", "page");
      else a.removeAttribute("aria-current");
    });
    document.documentElement.lang = lang;
    if (remember) {
      try { localStorage.setItem("lang", lang); } catch { /* ignore */ }
      try { history.replaceState(null, "", "#" + lang); } catch { /* ignore */ }
    }
  }

  tabs.forEach((a) => a.addEventListener("click", (e) => {
    e.preventDefault();
    pick(a.getAttribute("href").slice(1), true);
    window.scrollTo({ top: 0 });
  }));

  window.addEventListener("hashchange", () => {
    const h = location.hash.slice(1);
    if (known.includes(h)) pick(h, false);
  });

  let lang = location.hash.slice(1);
  if (!known.includes(lang)) {
    try { lang = localStorage.getItem("lang") || ""; } catch { lang = ""; }
  }
  if (!known.includes(lang)) {
    const nav = (navigator.language || "").toLowerCase().slice(0, 2);
    lang = known.includes(nav) ? nav : known[0];
  }
  pick(lang, false);
})();
