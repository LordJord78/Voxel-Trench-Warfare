# TRENCHLINE's card for the portfolio site

The card for the Projects section of the portfolio site (`~/repos/portfolio-website`), in the site's own markup and classes.

1. Copy `trenchline.webp` into the site's `assets/`.
2. Paste `card.html` first inside `<section id="projects">`'s `<div class="about-containers">`, above the three placeholder projects (keep or replace them).

Its buttons go to the code (https://github.com/LordJord78/Voxel-Trench-Warfare) and to the game (https://lordjord78.github.io/Voxel-Trench-Warfare/). The game's address works once the site is published: the Pages workflow (`.github/workflows/pages.yml`) deploys it on a push to `main`, with Pages turned on for the repository and "GitHub Actions" as its source.

The thumbnail is the middle of the game's still, square, made by `npm run stills` with the page's still and its link-preview image.
