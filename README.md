<div align="center">
  <img src="build/appicon.png" width="120" alt="Drossh"/>
  <h1>Drossh</h1>
  <p><b>Client SSH léger</b> — terminal, gestionnaire de connexions et explorateur de fichiers SFTP.</p>
</div>

---

Drossh est un client SSH de bureau, léger (~10 Mo) et rapide, construit avec
[Wails](https://wails.io) (Go + interface web). Il réunit dans une seule fenêtre
un terminal, tes connexions rangées en dossiers, et un explorateur de fichiers
distant — avec édition des fichiers directement dans ton éditeur habituel.

## Aperçu

<div align="center">
  <img src="docs/screenshots/03-session.png" width="820" alt="Session SSH : terminal multi-onglets et explorateur SFTP"/>
  <p><i>Une session active : terminal multi-onglets au centre, explorateur SFTP à gauche, connexions rangées en dossiers à droite.</i></p>
</div>

<table>
  <tr>
    <td width="50%">
      <img src="docs/screenshots/01-accueil.png" alt="Écran d'accueil et connexions enregistrées"/>
      <p align="center"><i>Écran d'accueil — connexions rangées en dossiers</i></p>
    </td>
    <td width="50%">
      <img src="docs/screenshots/02-nouvelle-connexion.png" alt="Fenêtre Nouvelle connexion"/>
      <p align="center"><i>Nouvelle connexion — mot de passe ou clé enregistrée</i></p>
    </td>
  </tr>
</table>

## Fonctionnalités

- 🔌 **Connexions SSH** sauvegardées, rangées en dossiers (glisser-déposer)
- 🔑 Authentification par **mot de passe** ou **clé privée** (gestionnaire de clés)
- 🪟 **Terminal** multi-onglets (xterm.js), copier/coller `Ctrl+Maj+C/V`
- 📂 **Explorateur SFTP** : navigation, icônes par type de fichier, clic droit
  (nouveau fichier/dossier, supprimer, « ouvrir un terminal ici »)
- ✨ **Édition aller-retour** : double-clic sur un fichier → il s'ouvre dans ton
  éditeur par défaut, et chaque sauvegarde est **ré-uploadée automatiquement**
- 🧭 Fil d'Ariane cliquable, panneaux redimensionnables et repliables

## Installation

| Système | Fichier | Remarque |
|---|---|---|
| **Toute distribution Linux** | `Drossh-*.AppImage` | **Recommandé** — autonome, rien à installer |
| **Debian 12+ / Ubuntu 22.04+** | `drossh_*_amd64.deb` | Confort `apt` ; distros plus anciennes → AppImage |
| **Arch / CachyOS / Manjaro** | `*-archlinux-x86_64.tar.gz` ou l'AppImage | Publication AUR à venir |
| **Windows 10/11** | `Drossh-*-windows-amd64.exe` | Fonctionne tel quel (WebView2 intégré) |

### AppImage (toute distribution Linux) — recommandé

L'AppImage est un fichier unique qui **embarque tout ce qu'il faut** (webkit, gtk
et leurs dépendances). Aucune installation, aucune dépendance à gérer : elle
fonctionne sur n'importe quelle distribution Linux récente, même sans
`webkit2gtk` installé sur le système.

1. Télécharge le fichier `Drossh-*.AppImage` depuis les [Releases](../../releases).
2. Rends-le exécutable :
   ```bash
   chmod +x Drossh-*.AppImage
   ```
3. Lance-le :
   ```bash
   ./Drossh-*.AppImage
   ```

> 💡 Pour l'avoir dans ton menu d'applications, tu peux le déplacer dans
> `~/Applications/` (ou `~/.local/bin/`) ; la plupart des bureaux l'intègrent
> alors automatiquement. Sinon, l'outil [Gear Lever](https://flathub.org/apps/it.mijorus.gearlever)
> gère l'intégration et les mises à jour des AppImage en un clic.
>
> Si rien ne s'affiche (fenêtre blanche) sur une carte NVIDIA, lance-la avec
> `WEBKIT_DISABLE_DMABUF_RENDERER=1 ./Drossh-*.AppImage` (déjà activé par défaut).

## Développement

Tout l'outillage reste dans Docker (rien à installer sur la machine hôte) :

```bash
# Construire l'image de dev (Go + Node + Wails)
docker build -t drossh-dev -f Dockerfile.dev .

# Compiler l'application
./dev.sh build -tags webkit2_41

# Le binaire se trouve dans build/bin/drossh
```

> Sous Linux, l'app a besoin des bibliothèques `webkit2gtk-4.1` et `gtk3` pour
> s'exécuter (déjà présentes sur la plupart des bureaux).

## Licence

[MIT](LICENSE) © Jules Pauly
