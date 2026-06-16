# Directory Sync

Keep a folder mirrored from one machine to another inside Frontier.

Directory Sync keeps a directory on one of your machines copied onto another, automatically. Point it at a source folder and a target folder, and it checks the source and pushes changes across so the target always matches — on a schedule you set, or on demand whenever you want. It's the no-fuss way to keep the same folder in two places: a project you edit on your laptop and run on a server, a notes folder you want present on every machine, a shared asset directory across boxes. Set it once and forget it.

<!-- screenshot: the Directory Sync sidebar listing sync pairs with their status -->

## Features

- Mirror a folder from one machine to another (or to a second folder on the same machine)
- Runs on a schedule, or sync on demand with one click
- Set up as many sync pairs as you need, each with its own status at a glance
- Skips the folders you'd expect by default (like `.git` and `node_modules`)

## Limitations

- **One-way mirror.** Changes flow from the source to the target only. The target is made to match the source — files removed from the source are removed from the target — so edits made only on the target get overwritten on the next sync. It's a mirror, not a two-way merge.
- **Whole files.** A changed file is copied in full, not patched in pieces.
- **Skips symlinks.** Symbolic links are reported but never copied.

## Install

Install Directory Sync from the **Applications → Marketplace** tab in Frontier: find Directory Sync, click Install, and approve the access it asks for (it reads and writes files on your machines to do the mirroring). Frontier verifies the download before installing. Once it's in, the Directory Sync sidebar appears — create a pair to start mirroring.
