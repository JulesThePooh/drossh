package main

import (
	"context"
	"crypto/sha1"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/pkg/sftp"
	"github.com/wailsapp/wails/v2/pkg/runtime"
	"golang.org/x/crypto/ssh"
)

// AppVersion = version courante de l'appli. Injectée au build depuis le tag git
// via -ldflags "-X main.AppVersion=X.Y.Z" (voir .github/workflows/release.yml).
// Valeur "dev" en build local non taggé. Ne plus jamais bumper à la main.
var AppVersion = "dev"

// App struct
type App struct {
	ctx      context.Context
	mu       sync.Mutex
	sessions map[string]*sshSession
	counter  int
	editing  map[string]bool
	editMu   sync.Mutex
}

// sshSession = une connexion SSH ouverte + son shell interactif.
type sshSession struct {
	client  *ssh.Client
	session *ssh.Session
	stdin   io.WriteCloser
	sftp    *sftp.Client
	sftpMu  sync.Mutex
}

// ConnectOptions = ce que le formulaire envoie pour ouvrir une connexion.
type ConnectOptions struct {
	Host       string `json:"host"`
	Port       int    `json:"port"`
	User       string `json:"user"`
	Password   string `json:"password"`
	KeyPath    string `json:"keyPath"`
	Passphrase string `json:"passphrase"`
	InitialDir string `json:"initialDir"` // si défini : le shell démarre avec un cd dessus
}

// shellQuote protège un chemin pour une ligne de commande shell.
func shellQuote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}

// NewApp creates a new App application struct
func NewApp() *App {
	return &App{sessions: make(map[string]*sshSession), editing: make(map[string]bool)}
}

// startup is called when the app starts.
func (a *App) startup(ctx context.Context) {
	a.ctx = ctx
}

// expandHome remplace un ~ initial par le dossier personnel.
func expandHome(p string) string {
	if strings.HasPrefix(p, "~") {
		if home, err := os.UserHomeDir(); err == nil {
			return filepath.Join(home, strings.TrimPrefix(p, "~"))
		}
	}
	return p
}

// Connect ouvre une connexion SSH + un shell interactif.
// Retourne un identifiant de session (pour SendInput/Resize/Disconnect).
func (a *App) Connect(opts ConnectOptions) (string, error) {
	var auths []ssh.AuthMethod

	// --- Authentification par clé privée ---
	if opts.KeyPath != "" {
		keyBytes, err := os.ReadFile(expandHome(opts.KeyPath))
		if err != nil {
			return "", fmt.Errorf("lecture de la clé impossible : %w", err)
		}
		var signer ssh.Signer
		if opts.Passphrase != "" {
			signer, err = ssh.ParsePrivateKeyWithPassphrase(keyBytes, []byte(opts.Passphrase))
		} else {
			signer, err = ssh.ParsePrivateKey(keyBytes)
		}
		if err != nil {
			return "", fmt.Errorf("clé privée invalide (passphrase ?) : %w", err)
		}
		auths = append(auths, ssh.PublicKeys(signer))
	}

	// --- Authentification par mot de passe ---
	if opts.Password != "" {
		auths = append(auths, ssh.Password(opts.Password))
	}

	if len(auths) == 0 {
		return "", fmt.Errorf("aucune authentification fournie (mot de passe ou clé)")
	}

	port := opts.Port
	if port == 0 {
		port = 22
	}

	config := &ssh.ClientConfig{
		User:            opts.User,
		Auth:            auths,
		HostKeyCallback: ssh.InsecureIgnoreHostKey(), // TODO: vérification known_hosts (étape sécu ultérieure)
		Timeout:         10 * time.Second,
	}

	addr := net.JoinHostPort(opts.Host, fmt.Sprintf("%d", port))
	client, err := ssh.Dial("tcp", addr, config)
	if err != nil {
		return "", fmt.Errorf("connexion impossible : %w", err)
	}

	session, err := client.NewSession()
	if err != nil {
		client.Close()
		return "", fmt.Errorf("ouverture de session impossible : %w", err)
	}

	modes := ssh.TerminalModes{
		ssh.ECHO:          1,
		ssh.TTY_OP_ISPEED: 14400,
		ssh.TTY_OP_OSPEED: 14400,
	}
	if err := session.RequestPty("xterm-256color", 24, 80, modes); err != nil {
		session.Close()
		client.Close()
		return "", fmt.Errorf("pty refusé : %w", err)
	}

	stdin, err := session.StdinPipe()
	if err != nil {
		session.Close()
		client.Close()
		return "", err
	}
	stdout, err := session.StdoutPipe()
	if err != nil {
		session.Close()
		client.Close()
		return "", err
	}
	stderr, err := session.StderrPipe()
	if err != nil {
		session.Close()
		client.Close()
		return "", err
	}

	if err := session.Shell(); err != nil {
		session.Close()
		client.Close()
		return "", fmt.Errorf("lancement du shell impossible : %w", err)
	}

	// Démarrage dans un dossier précis (pour "Ouvrir un terminal ici").
	if opts.InitialDir != "" {
		stdin.Write([]byte("cd " + shellQuote(opts.InitialDir) + "\n"))
	}

	a.mu.Lock()
	a.counter++
	id := fmt.Sprintf("s%d", a.counter)
	a.sessions[id] = &sshSession{client: client, session: session, stdin: stdin}
	a.mu.Unlock()

	// On pompe la sortie du serveur vers le frontend.
	go a.pump(id, stdout)
	go a.pump(id, stderr)
	// Quand le shell se termine, on nettoie et on prévient le frontend.
	go func() {
		session.Wait()
		a.cleanup(id)
		runtime.EventsEmit(a.ctx, "term:exit", id)
	}()

	return id, nil
}

// pump lit la sortie du serveur et l'envoie au frontend en base64
// (robuste même si la sortie contient des octets non-UTF8).
func (a *App) pump(id string, r io.Reader) {
	buf := make([]byte, 4096)
	for {
		n, err := r.Read(buf)
		if n > 0 {
			runtime.EventsEmit(a.ctx, "term:data", map[string]string{
				"id":  id,
				"b64": base64.StdEncoding.EncodeToString(buf[:n]),
			})
		}
		if err != nil {
			return
		}
	}
}

func (a *App) get(id string) *sshSession {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.sessions[id]
}

func (a *App) cleanup(id string) {
	a.mu.Lock()
	s := a.sessions[id]
	delete(a.sessions, id)
	a.mu.Unlock()
	if s != nil {
		if s.sftp != nil {
			s.sftp.Close()
		}
		s.session.Close()
		s.client.Close()
	}
}

// SendInput envoie une frappe clavier au shell distant.
func (a *App) SendInput(id string, data string) error {
	s := a.get(id)
	if s == nil {
		return fmt.Errorf("session introuvable")
	}
	_, err := s.stdin.Write([]byte(data))
	return err
}

// Resize informe le serveur de la nouvelle taille du terminal.
func (a *App) Resize(id string, cols int, rows int) error {
	s := a.get(id)
	if s == nil {
		return fmt.Errorf("session introuvable")
	}
	return s.session.WindowChange(rows, cols)
}

// Disconnect ferme proprement la session.
func (a *App) Disconnect(id string) error {
	a.cleanup(id)
	return nil
}

/* =========================================================================
   SFTP : explorateur de fichiers du serveur
   ========================================================================= */

// FileEntry = une entrée de dossier distant.
type FileEntry struct {
	Name    string `json:"name"`
	Path    string `json:"path"`
	IsDir   bool   `json:"isDir"`
	Size    int64  `json:"size"`
	Mode    string `json:"mode"`
	ModTime string `json:"modTime"`
}

// getSFTP ouvre (une fois) le client SFTP sur la session SSH existante.
func (a *App) getSFTP(id string) (*sftp.Client, error) {
	s := a.get(id)
	if s == nil {
		return nil, fmt.Errorf("session introuvable")
	}
	s.sftpMu.Lock()
	defer s.sftpMu.Unlock()
	if s.sftp != nil {
		return s.sftp, nil
	}
	c, err := sftp.NewClient(s.client)
	if err != nil {
		return nil, fmt.Errorf("SFTP indisponible : %w", err)
	}
	s.sftp = c
	return c, nil
}

// HomeDir renvoie le dossier de départ (répertoire courant du serveur).
func (a *App) HomeDir(id string) (string, error) {
	c, err := a.getSFTP(id)
	if err != nil {
		return "", err
	}
	wd, err := c.Getwd()
	if err != nil || wd == "" {
		return "/", nil
	}
	return wd, nil
}

// ListDir liste le contenu d'un dossier distant (dossiers d'abord, puis fichiers).
func (a *App) ListDir(id string, dir string) ([]FileEntry, error) {
	c, err := a.getSFTP(id)
	if err != nil {
		return nil, err
	}
	if dir == "" {
		if wd, e := c.Getwd(); e == nil && wd != "" {
			dir = wd
		} else {
			dir = "/"
		}
	}
	infos, err := c.ReadDir(dir)
	if err != nil {
		return nil, fmt.Errorf("lecture du dossier impossible : %w", err)
	}
	entries := make([]FileEntry, 0, len(infos))
	for _, fi := range infos {
		entries = append(entries, FileEntry{
			Name:    fi.Name(),
			Path:    path.Join(dir, fi.Name()),
			IsDir:   fi.IsDir(),
			Size:    fi.Size(),
			Mode:    fi.Mode().String(),
			ModTime: fi.ModTime().Format("2006-01-02 15:04"),
		})
	}
	sort.Slice(entries, func(i, j int) bool {
		if entries[i].IsDir != entries[j].IsDir {
			return entries[i].IsDir
		}
		return strings.ToLower(entries[i].Name) < strings.ToLower(entries[j].Name)
	})
	return entries, nil
}

/* =========================================================================
   Édition : télécharger → éditeur par défaut → ré-upload à la sauvegarde
   ========================================================================= */

// EditFile télécharge un fichier distant, l'ouvre dans l'éditeur par défaut,
// et le ré-uploade automatiquement à chaque sauvegarde (jusqu'à la fermeture de la session).
func (a *App) EditFile(id string, remotePath string) error {
	c, err := a.getSFTP(id)
	if err != nil {
		return err
	}

	key := id + ":" + remotePath
	a.editMu.Lock()
	already := a.editing[key]
	if !already {
		a.editing[key] = true
	}
	a.editMu.Unlock()

	// Fichier local temporaire (un sous-dossier par dossier distant → pas de collision, extension conservée).
	base := path.Base(remotePath)
	sum := sha1.Sum([]byte(id + path.Dir(remotePath)))
	localDir := filepath.Join(os.TempDir(), "drossh-edit", hex.EncodeToString(sum[:])[:10])
	local := filepath.Join(localDir, base)

	// On ne (re)télécharge QUE si ce n'est pas déjà en cours d'édition :
	// rouvrir un fichier déjà surveillé ne doit pas déclencher un faux upload.
	if !already {
		if err := os.MkdirAll(localDir, 0o700); err != nil {
			a.unedit(key, already)
			return err
		}
		if err := a.downloadFile(c, remotePath, local, nil); err != nil {
			a.unedit(key, already)
			return err
		}
	}

	// Ouvre dans l'application par défaut de l'OS.
	if err := exec.Command("xdg-open", local).Start(); err != nil {
		a.unedit(key, already)
		return fmt.Errorf("ouverture de l'éditeur impossible : %w", err)
	}

	// Un seul surveillant par fichier.
	if already {
		return nil
	}
	runtime.EventsEmit(a.ctx, "file:editing", remotePath)
	go a.watchAndUpload(id, key, remotePath, local)
	return nil
}

func (a *App) unedit(key string, keepIfAlready bool) {
	if keepIfAlready {
		return
	}
	a.editMu.Lock()
	delete(a.editing, key)
	a.editMu.Unlock()
}

// onBytes, s'il est fourni, est appelé avec le nombre d'octets de chaque bloc
// copié : c'est ce qui alimente la barre de progression.
func (a *App) downloadFile(c *sftp.Client, remotePath, local string, onBytes func(int64)) error {
	rf, err := c.Open(remotePath)
	if err != nil {
		return fmt.Errorf("ouverture distante impossible : %w", err)
	}
	defer rf.Close()
	lf, err := os.Create(local)
	if err != nil {
		return err
	}
	defer lf.Close()
	var dst io.Writer = lf
	if onBytes != nil {
		dst = io.MultiWriter(lf, writerFunc(func(p []byte) (int, error) {
			onBytes(int64(len(p)))
			return len(p), nil
		}))
	}
	_, err = io.Copy(dst, rf)
	return err
}

func (a *App) uploadFile(c *sftp.Client, local, remotePath string, onBytes func(int64)) error {
	lf, err := os.Open(local)
	if err != nil {
		return err
	}
	defer lf.Close()
	rf, err := c.Create(remotePath) // tronque puis réécrit
	if err != nil {
		return err
	}
	defer rf.Close()
	var dst io.Writer = rf
	if onBytes != nil {
		dst = io.MultiWriter(rf, writerFunc(func(p []byte) (int, error) {
			onBytes(int64(len(p)))
			return len(p), nil
		}))
	}
	_, err = io.Copy(dst, lf)
	return err
}

// watchAndUpload surveille la date de modif du fichier local et ré-uploade à chaque changement.
func (a *App) watchAndUpload(id, key, remotePath, local string) {
	defer func() {
		a.editMu.Lock()
		delete(a.editing, key)
		a.editMu.Unlock()
	}()
	info, err := os.Stat(local)
	if err != nil {
		return
	}
	last := info.ModTime()
	for {
		time.Sleep(800 * time.Millisecond)
		if a.get(id) == nil {
			return // session fermée
		}
		fi, err := os.Stat(local)
		if err != nil {
			return // fichier supprimé
		}
		if fi.ModTime().After(last) {
			time.Sleep(250 * time.Millisecond) // laisse l'éditeur finir d'écrire
			last = fi.ModTime()
			c, err := a.getSFTP(id)
			if err != nil {
				return
			}
			if err := a.uploadFile(c, local, remotePath, nil); err != nil {
				runtime.EventsEmit(a.ctx, "file:error", map[string]string{"path": remotePath, "error": err.Error()})
			} else {
				runtime.EventsEmit(a.ctx, "file:uploaded", remotePath)
			}
		}
	}
}

// MakeDir crée un dossier distant (et les parents si besoin).
func (a *App) MakeDir(id string, dir string) error {
	c, err := a.getSFTP(id)
	if err != nil {
		return err
	}
	return c.MkdirAll(dir)
}

// MakeFile crée un fichier vide distant (erreur s'il existe déjà).
func (a *App) MakeFile(id string, filePath string) error {
	c, err := a.getSFTP(id)
	if err != nil {
		return err
	}
	if _, err := c.Stat(filePath); err == nil {
		return fmt.Errorf("ce fichier existe déjà")
	}
	f, err := c.OpenFile(filePath, os.O_WRONLY|os.O_CREATE|os.O_EXCL)
	if err != nil {
		return err
	}
	return f.Close()
}

// Remove supprime un fichier ou un dossier distant (récursivement pour un dossier).
func (a *App) Remove(id string, p string) error {
	c, err := a.getSFTP(id)
	if err != nil {
		return err
	}
	return removeRecursive(c, p)
}

func removeRecursive(c *sftp.Client, p string) error {
	fi, err := c.Stat(p)
	if err != nil {
		return err
	}
	if fi.IsDir() {
		entries, err := c.ReadDir(p)
		if err != nil {
			return err
		}
		for _, e := range entries {
			if err := removeRecursive(c, path.Join(p, e.Name())); err != nil {
				return err
			}
		}
		return c.RemoveDirectory(p)
	}
	return c.Remove(p)
}

/* =========================================================================
   Progression des transferts (barre + détails côté interface)
   ========================================================================= */

// writerFunc permet d'utiliser une simple fonction comme io.Writer,
// pour compter les octets au fil de l'eau sans buffer intermédiaire.
type writerFunc func(p []byte) (int, error)

func (f writerFunc) Write(p []byte) (int, error) { return f(p) }

// xfer suit la progression d'un transfert (import ou export) et émet des
// événements "transfer:*" vers l'interface, en limitant la fréquence d'émission
// pour ne pas inonder le pont Wails.
type xfer struct {
	app       *App
	id        string
	kind      string // "upload" (import) | "download" (export)
	total     int64  // octets attendus au total (0 si inconnu)
	totalN    int    // nombre de fichiers prévus
	done      int64  // octets déjà transférés
	doneN     int    // fichiers terminés
	current   string // nom du fichier en cours
	start     time.Time
	lastEmit  time.Time
	lastBytes int64
	speed     float64 // octets/s, lissé
	mu        sync.Mutex
}

// newXfer crée un suivi et prévient l'interface qu'un transfert démarre.
func (a *App) newXfer(kind string, total int64, totalN int) *xfer {
	a.mu.Lock()
	a.counter++
	id := fmt.Sprintf("x%d", a.counter)
	a.mu.Unlock()
	now := time.Now()
	x := &xfer{app: a, id: id, kind: kind, total: total, totalN: totalN, start: now, lastEmit: now}
	runtime.EventsEmit(a.ctx, "transfer:start", map[string]any{
		"id": id, "kind": kind, "total": total, "totalFiles": totalN,
	})
	return x
}

// setCurrent signale le passage à un nouveau fichier (émission immédiate).
func (x *xfer) setCurrent(name string) {
	x.mu.Lock()
	x.current = name
	x.mu.Unlock()
	x.emit(true)
}

// add comptabilise n octets transférés (émission limitée à ~tous les 90 ms).
func (x *xfer) add(n int64) {
	x.mu.Lock()
	x.done += n
	x.mu.Unlock()
	x.emit(false)
}

// fileDone marque un fichier comme terminé.
func (x *xfer) fileDone() {
	x.mu.Lock()
	x.doneN++
	x.mu.Unlock()
}

// emit envoie l'état courant à l'interface, en calculant une vitesse lissée.
func (x *xfer) emit(force bool) {
	x.mu.Lock()
	now := time.Now()
	if !force && now.Sub(x.lastEmit) < 90*time.Millisecond {
		x.mu.Unlock()
		return
	}
	if dt := now.Sub(x.lastEmit).Seconds(); dt > 0 {
		inst := float64(x.done-x.lastBytes) / dt
		if x.speed == 0 {
			x.speed = inst
		} else {
			x.speed = x.speed*0.7 + inst*0.3 // lissage exponentiel
		}
	}
	x.lastEmit = now
	x.lastBytes = x.done
	payload := map[string]any{
		"id": x.id, "kind": x.kind,
		"done": x.done, "total": x.total,
		"filesDone": x.doneN, "totalFiles": x.totalN,
		"current": x.current, "speed": x.speed,
	}
	x.mu.Unlock()
	runtime.EventsEmit(x.app.ctx, "transfer:progress", payload)
}

// finish clôt le transfert : une dernière progression puis fin ou erreur.
func (x *xfer) finish(err error) {
	x.emit(true)
	if err != nil {
		runtime.EventsEmit(x.app.ctx, "transfer:error", map[string]any{"id": x.id, "error": err.Error()})
		return
	}
	runtime.EventsEmit(x.app.ctx, "transfer:done", map[string]any{"id": x.id})
}

// dirStats parcourt récursivement un dossier distant et renvoie le total
// d'octets et le nombre de fichiers réguliers (pour dimensionner la barre).
func dirStats(c *sftp.Client, remoteDir string) (int64, int) {
	var bytes int64
	var n int
	entries, err := c.ReadDir(remoteDir)
	if err != nil {
		return bytes, n
	}
	for _, fi := range entries {
		switch {
		case fi.IsDir():
			b, k := dirStats(c, path.Join(remoteDir, fi.Name()))
			bytes += b
			n += k
		case fi.Mode().IsRegular():
			bytes += fi.Size()
			n++
		}
	}
	return bytes, n
}

/* =========================================================================
   Transferts : télécharger (fichier / dossier), importer, extraire
   ========================================================================= */

// DownloadFileTo télécharge un fichier distant vers un emplacement local choisi
// par l'utilisateur (boîte "Enregistrer sous…"). Renvoie le chemin local, ou "" si annulé.
func (a *App) DownloadFileTo(id string, remotePath string) (string, error) {
	c, err := a.getSFTP(id)
	if err != nil {
		return "", err
	}
	target, err := runtime.SaveFileDialog(a.ctx, runtime.SaveDialogOptions{
		Title:           "Enregistrer le fichier sous…",
		DefaultFilename: path.Base(remotePath),
	})
	if err != nil {
		return "", err
	}
	if target == "" {
		return "", nil // annulé
	}
	var total int64
	if fi, err := c.Stat(remotePath); err == nil {
		total = fi.Size()
	}
	x := a.newXfer("download", total, 1)
	x.setCurrent(path.Base(remotePath))
	err = a.downloadFile(c, remotePath, target, x.add)
	if err == nil {
		x.fileDone()
	}
	x.finish(err)
	if err != nil {
		return "", err
	}
	return target, nil
}

// DownloadDirTo télécharge récursivement un dossier distant dans un dossier local
// choisi par l'utilisateur. Renvoie le chemin local créé, ou "" si annulé.
func (a *App) DownloadDirTo(id string, remotePath string) (string, error) {
	c, err := a.getSFTP(id)
	if err != nil {
		return "", err
	}
	dest, err := runtime.OpenDirectoryDialog(a.ctx, runtime.OpenDialogOptions{
		Title: "Où enregistrer le dossier ?",
	})
	if err != nil {
		return "", err
	}
	if dest == "" {
		return "", nil // annulé
	}
	target := filepath.Join(dest, path.Base(remotePath))
	total, nfiles := dirStats(c, remotePath)
	x := a.newXfer("download", total, nfiles)
	err = a.downloadDir(c, remotePath, target, x)
	x.finish(err)
	if err != nil {
		return "", err
	}
	return target, nil
}

// downloadDir copie récursivement remoteDir vers localDir (fichiers réguliers uniquement).
// x, s'il est fourni, reçoit la progression au fur et à mesure.
func (a *App) downloadDir(c *sftp.Client, remoteDir, localDir string, x *xfer) error {
	if err := os.MkdirAll(localDir, 0o755); err != nil {
		return err
	}
	entries, err := c.ReadDir(remoteDir)
	if err != nil {
		return err
	}
	for _, fi := range entries {
		rp := path.Join(remoteDir, fi.Name())
		lp := filepath.Join(localDir, fi.Name())
		switch {
		case fi.IsDir():
			if err := a.downloadDir(c, rp, lp, x); err != nil {
				return err
			}
		case fi.Mode().IsRegular():
			var cb func(int64)
			if x != nil {
				x.setCurrent(fi.Name())
				cb = x.add
			}
			if err := a.downloadFile(c, rp, lp, cb); err != nil {
				return err
			}
			if x != nil {
				x.fileDone()
			}
			// les liens/fichiers spéciaux sont ignorés
		}
	}
	return nil
}

// UploadFileTo demande un fichier local et l'uploade dans remoteDir.
// Renvoie le nom du fichier importé, ou "" si annulé.
func (a *App) UploadFileTo(id string, remoteDir string) (string, error) {
	c, err := a.getSFTP(id)
	if err != nil {
		return "", err
	}
	local, err := runtime.OpenFileDialog(a.ctx, runtime.OpenDialogOptions{
		Title: "Choisir un fichier à importer",
	})
	if err != nil {
		return "", err
	}
	if local == "" {
		return "", nil // annulé
	}
	name := filepath.Base(local)
	remotePath := path.Join(remoteDir, name)
	var total int64
	if fi, err := os.Stat(local); err == nil {
		total = fi.Size()
	}
	x := a.newXfer("upload", total, 1)
	x.setCurrent(name)
	err = a.uploadFile(c, local, remotePath, x.add)
	if err == nil {
		x.fileDone()
	}
	x.finish(err)
	if err != nil {
		return "", err
	}
	return name, nil
}

// ExtractArchive extrait une archive distante dans son propre dossier, côté serveur
// (l'outil adéquat doit être installé sur le serveur : tar, unzip, unrar, 7z…).
func (a *App) ExtractArchive(id string, remotePath string) error {
	s := a.get(id)
	if s == nil {
		return fmt.Errorf("session introuvable")
	}
	cmd := extractCommand(path.Base(remotePath))
	if cmd == "" {
		return fmt.Errorf("format d'archive non reconnu")
	}
	full := "cd " + shellQuote(path.Dir(remotePath)) + " && " + cmd
	sess, err := s.client.NewSession()
	if err != nil {
		return err
	}
	defer sess.Close()
	out, err := sess.CombinedOutput(full)
	if err != nil {
		msg := strings.TrimSpace(string(out))
		if msg == "" {
			msg = err.Error()
		}
		return fmt.Errorf("%s", msg)
	}
	return nil
}

// extractCommand renvoie la commande shell d'extraction selon l'extension (nom déjà
// protégé par shellQuote), ou "" si le format n'est pas reconnu.
func extractCommand(name string) string {
	q := shellQuote(name)
	l := strings.ToLower(name)
	switch {
	case strings.HasSuffix(l, ".tar.gz"), strings.HasSuffix(l, ".tgz"):
		return "tar -xzf " + q
	case strings.HasSuffix(l, ".tar.bz2"), strings.HasSuffix(l, ".tbz2"):
		return "tar -xjf " + q
	case strings.HasSuffix(l, ".tar.xz"), strings.HasSuffix(l, ".txz"):
		return "tar -xJf " + q
	case strings.HasSuffix(l, ".tar.zst"), strings.HasSuffix(l, ".tzst"):
		return "tar --zstd -xf " + q
	case strings.HasSuffix(l, ".tar"):
		return "tar -xf " + q
	case strings.HasSuffix(l, ".zip"):
		return "unzip -o " + q
	case strings.HasSuffix(l, ".rar"):
		return "unrar x -o+ " + q
	case strings.HasSuffix(l, ".7z"):
		return "7z x -y " + q
	case strings.HasSuffix(l, ".gz"):
		return "gunzip -k " + q
	case strings.HasSuffix(l, ".bz2"):
		return "bunzip2 -k " + q
	case strings.HasSuffix(l, ".xz"):
		return "unxz -k " + q
	case strings.HasSuffix(l, ".zst"):
		return "unzstd -k " + q
	default:
		return ""
	}
}

// PickKeyFile ouvre un sélecteur de fichier natif (démarre dans ~/.ssh).
func (a *App) PickKeyFile() (string, error) {
	start := ""
	if home, err := os.UserHomeDir(); err == nil {
		start = filepath.Join(home, ".ssh")
	}
	return runtime.OpenFileDialog(a.ctx, runtime.OpenDialogOptions{
		Title:            "Choisir une clé privée",
		DefaultDirectory: start,
	})
}

/* =========================================================================
   Persistance : dossiers, connexions et clés enregistrées (~/.config/drossh)
   ========================================================================= */

type Folder struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

type Connection struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	FolderID string `json:"folderId"`
	Host     string `json:"host"`
	Port     int    `json:"port"`
	User     string `json:"user"`
	AuthType string `json:"authType"` // "password" ou "key"
	Password string `json:"password"`
	KeyID    string `json:"keyId"`
}

type SSHKey struct {
	ID         string `json:"id"`
	Name       string `json:"name"`
	Path       string `json:"path"`
	Passphrase string `json:"passphrase"`
}

type Store struct {
	Folders     []Folder     `json:"folders"`
	Connections []Connection `json:"connections"`
	Keys        []SSHKey     `json:"keys"`
	Language    string       `json:"language"` // code langue choisi ("" = détection auto)
}

// storePath renvoie le chemin du fichier de config (et crée le dossier).
func (a *App) storePath() (string, error) {
	dir, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	d := filepath.Join(dir, "drossh")
	if err := os.MkdirAll(d, 0o700); err != nil {
		return "", err
	}
	return filepath.Join(d, "store.json"), nil
}

// LoadStore lit la config (ou renvoie une config vide si elle n'existe pas).
func (a *App) LoadStore() (Store, error) {
	empty := Store{Folders: []Folder{}, Connections: []Connection{}, Keys: []SSHKey{}}
	path, err := a.storePath()
	if err != nil {
		return empty, err
	}
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return empty, nil
		}
		return empty, err
	}
	var s Store
	if err := json.Unmarshal(data, &s); err != nil {
		return empty, err
	}
	if s.Folders == nil {
		s.Folders = []Folder{}
	}
	if s.Connections == nil {
		s.Connections = []Connection{}
	}
	if s.Keys == nil {
		s.Keys = []SSHKey{}
	}
	return s, nil
}

// SaveStore écrit la config sur le disque (permissions 0600, lisible par toi seul).
func (a *App) SaveStore(s Store) error {
	path, err := a.storePath()
	if err != nil {
		return err
	}
	data, err := json.MarshalIndent(s, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, data, 0o600)
}

/* =========================================================================
   Version & vérificateur de mises à jour (interroge l'API GitHub Releases)
   ========================================================================= */

// Version renvoie la version courante de l'appli (pour l'affichage).
func (a *App) Version() string { return AppVersion }

// UpdateInfo = résultat d'une vérification de mise à jour.
type UpdateInfo struct {
	Current string `json:"current"` // version installée
	Latest  string `json:"latest"`  // dernière version publiée (sans le "v")
	URL     string `json:"url"`     // page de la release à télécharger
	Newer   bool   `json:"newer"`   // vrai si une version plus récente existe
}

// CheckUpdate interroge la dernière release GitHub et compare à la version courante.
// Ne force rien : renvoie juste l'info, le frontend décide d'afficher ou non.
func (a *App) CheckUpdate() (UpdateInfo, error) {
	info := UpdateInfo{Current: AppVersion}

	req, err := http.NewRequest("GET", "https://api.github.com/repos/JulesThePooh/drossh/releases/latest", nil)
	if err != nil {
		return info, err
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("User-Agent", "drossh")

	client := &http.Client{Timeout: 8 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return info, fmt.Errorf("vérification impossible (réseau ?) : %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return info, fmt.Errorf("GitHub a répondu %d", resp.StatusCode)
	}

	var payload struct {
		TagName string `json:"tag_name"`
		HTMLURL string `json:"html_url"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&payload); err != nil {
		return info, err
	}

	info.Latest = strings.TrimPrefix(strings.TrimSpace(payload.TagName), "v")
	info.URL = payload.HTMLURL
	info.Newer = versionLess(AppVersion, info.Latest)
	return info, nil
}

// OpenURL ouvre un lien dans le navigateur par défaut de l'OS.
func (a *App) OpenURL(url string) {
	runtime.BrowserOpenURL(a.ctx, url)
}

// versionLess indique si a < b en comparant major.minor.patch.
func versionLess(a, b string) bool {
	av, bv := parseVersion(a), parseVersion(b)
	for i := 0; i < 3; i++ {
		if av[i] != bv[i] {
			return av[i] < bv[i]
		}
	}
	return false
}

func parseVersion(v string) [3]int {
	v = strings.TrimPrefix(strings.TrimSpace(v), "v")
	parts := strings.SplitN(v, ".", 3)
	var out [3]int
	for i := 0; i < 3 && i < len(parts); i++ {
		n := 0
		fmt.Sscanf(parts[i], "%d", &n)
		out[i] = n
	}
	return out
}

/* =========================================================================
   Export / import de la configuration (store.json) vers un autre PC
   ========================================================================= */

// ExportStore copie le store.json vers un emplacement choisi par l'utilisateur.
// Renvoie le chemin écrit, ou "" si l'utilisateur a annulé.
// ⚠️ Le fichier contient les secrets en clair (mots de passe, passphrases).
func (a *App) ExportStore() (string, error) {
	home, _ := os.UserHomeDir()
	target, err := runtime.SaveFileDialog(a.ctx, runtime.SaveDialogOptions{
		Title:            "Exporter la configuration",
		DefaultDirectory: home,
		DefaultFilename:  "drossh-config.json",
		Filters:          []runtime.FileFilter{{DisplayName: "Fichier JSON (*.json)", Pattern: "*.json"}},
	})
	if err != nil {
		return "", err
	}
	if target == "" {
		return "", nil // annulé
	}

	src, err := a.storePath()
	if err != nil {
		return "", err
	}
	data, err := os.ReadFile(src)
	if err != nil {
		if os.IsNotExist(err) {
			data = []byte("{}")
		} else {
			return "", err
		}
	}
	if err := os.WriteFile(target, data, 0o600); err != nil {
		return "", err
	}
	return target, nil
}

// ImportStore charge un fichier de config choisi par l'utilisateur, le valide,
// l'enregistre comme config courante et renvoie son contenu.
// Renvoie nil (sans erreur) si l'utilisateur a annulé.
func (a *App) ImportStore() (*Store, error) {
	home, _ := os.UserHomeDir()
	target, err := runtime.OpenFileDialog(a.ctx, runtime.OpenDialogOptions{
		Title:            "Importer une configuration",
		DefaultDirectory: home,
		Filters:          []runtime.FileFilter{{DisplayName: "Fichier JSON (*.json)", Pattern: "*.json"}},
	})
	if err != nil {
		return nil, err
	}
	if target == "" {
		return nil, nil // annulé
	}

	data, err := os.ReadFile(target)
	if err != nil {
		return nil, fmt.Errorf("lecture impossible : %w", err)
	}
	var s Store
	if err := json.Unmarshal(data, &s); err != nil {
		return nil, fmt.Errorf("fichier invalide (ce n'est pas une config Drossh ?) : %w", err)
	}
	if s.Folders == nil {
		s.Folders = []Folder{}
	}
	if s.Connections == nil {
		s.Connections = []Connection{}
	}
	if s.Keys == nil {
		s.Keys = []SSHKey{}
	}
	if err := a.SaveStore(s); err != nil {
		return nil, err
	}
	return &s, nil
}
