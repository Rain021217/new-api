package service

import (
	"crypto/sha256"
	"encoding/hex"
	"sync"
	"time"

	"github.com/QuantumNous/new-api/common"
)

// WeChatLoginSession is the server-side state for one scan-login attempt. It is keyed by
// a hash of the login token (never the plaintext token), so a cache or DB dump cannot be
// replayed: the plaintext token lives only in the browser and arrives on each poll.
type WeChatLoginSession struct {
	SceneID    string `json:"scene_id"`
	Status     string `json:"status"`
	WeChatId   string `json:"wechat_id,omitempty"`
	InviteCode string `json:"invite_code,omitempty"`
	// BindUserId is non-zero when this session was created from the authenticated bind
	// flow (POST /api/oauth/wechat/login/bind/qrcode). On success the openid is written
	// onto user BindUserId.wechat_id instead of starting a new login session.
	BindUserId   int   `json:"bind_user_id,omitempty"`
	ExpiresAt    int64 `json:"expires_at"`
	Consumed     bool  `json:"consumed"`
	LastPolledAt int64 `json:"last_polled_at,omitempty"`
}

type wechatLoginImage struct {
	ContentType string `json:"content_type"`
	Data        []byte `json:"data"`
}

const (
	wechatLoginSessionKeyPrefix = "wechat_login_session:"
	wechatLoginImageKeyPrefix   = "wechat_login_image:"
)

// wechatLoginStoreKey derives an opaque, fixed-length store key from a prefix and the
// plaintext login token. Only the SHA-256 hash is ever persisted.
func wechatLoginStoreKey(prefix, loginToken string) string {
	sum := sha256.Sum256([]byte(loginToken))
	return prefix + hex.EncodeToString(sum[:])
}

// --- in-memory fallback (single instance / Redis disabled / tests) ---

type wechatLoginMemEntry struct {
	payload   string
	expiresAt time.Time
}

var (
	wechatLoginMemMu    sync.Mutex
	wechatLoginMemStore = make(map[string]wechatLoginMemEntry)
)

func wechatLoginMemSet(key, payload string, ttl time.Duration) {
	wechatLoginMemMu.Lock()
	defer wechatLoginMemMu.Unlock()
	wechatLoginMemStore[key] = wechatLoginMemEntry{payload: payload, expiresAt: time.Now().Add(ttl)}
	wechatLoginMemPurgeLocked()
}

func wechatLoginMemGet(key string) (string, bool) {
	wechatLoginMemMu.Lock()
	defer wechatLoginMemMu.Unlock()
	entry, ok := wechatLoginMemStore[key]
	if !ok {
		return "", false
	}
	if time.Now().After(entry.expiresAt) {
		delete(wechatLoginMemStore, key)
		return "", false
	}
	return entry.payload, true
}

func wechatLoginMemDel(key string) {
	wechatLoginMemMu.Lock()
	defer wechatLoginMemMu.Unlock()
	delete(wechatLoginMemStore, key)
}

// wechatLoginMemPurgeLocked drops expired entries; the caller must hold wechatLoginMemMu.
func wechatLoginMemPurgeLocked() {
	now := time.Now()
	for k, v := range wechatLoginMemStore {
		if now.After(v.expiresAt) {
			delete(wechatLoginMemStore, k)
		}
	}
}

// --- storage layer (Redis when enabled for multi-instance, else in-memory) ---

func wechatLoginStorePut(key, payload string, ttl time.Duration) error {
	if common.RedisEnabled {
		return common.RedisSet(key, payload, ttl)
	}
	wechatLoginMemSet(key, payload, ttl)
	return nil
}

// wechatLoginStoreGet returns the payload and whether it was found. A Redis miss or any
// Redis error degrades to not-found, which the login flow treats as expired (fail-closed).
func wechatLoginStoreGet(key string) (string, bool) {
	if common.RedisEnabled {
		val, err := common.RedisGet(key)
		if err != nil {
			return "", false
		}
		return val, true
	}
	return wechatLoginMemGet(key)
}

func wechatLoginStoreDel(key string) error {
	if common.RedisEnabled {
		return common.RedisDel(key)
	}
	wechatLoginMemDel(key)
	return nil
}

// SaveWeChatLoginSession persists the poll state for a login token with a TTL.
func SaveWeChatLoginSession(loginToken string, session *WeChatLoginSession, ttl time.Duration) error {
	payload, err := common.Marshal(session)
	if err != nil {
		return err
	}
	return wechatLoginStorePut(wechatLoginStoreKey(wechatLoginSessionKeyPrefix, loginToken), string(payload), ttl)
}

// GetWeChatLoginSession loads the poll state for a login token. The bool is false when no
// live session exists (missing or expired).
func GetWeChatLoginSession(loginToken string) (*WeChatLoginSession, bool, error) {
	payload, ok := wechatLoginStoreGet(wechatLoginStoreKey(wechatLoginSessionKeyPrefix, loginToken))
	if !ok {
		return nil, false, nil
	}
	var session WeChatLoginSession
	if err := common.UnmarshalJsonStr(payload, &session); err != nil {
		return nil, false, err
	}
	return &session, true, nil
}

// DeleteWeChatLoginSession removes the poll state for a login token.
func DeleteWeChatLoginSession(loginToken string) error {
	return wechatLoginStoreDel(wechatLoginStoreKey(wechatLoginSessionKeyPrefix, loginToken))
}

// SaveWeChatLoginImage caches the downloaded QR image so /login/qrcode/image can serve it
// without re-hitting the external program. Stored under a separate key so frequent status
// polls never have to read the image bytes.
func SaveWeChatLoginImage(loginToken, contentType string, data []byte, ttl time.Duration) error {
	payload, err := common.Marshal(wechatLoginImage{ContentType: contentType, Data: data})
	if err != nil {
		return err
	}
	return wechatLoginStorePut(wechatLoginStoreKey(wechatLoginImageKeyPrefix, loginToken), string(payload), ttl)
}

// GetWeChatLoginImage returns the cached QR image (content type + bytes) for a login token.
func GetWeChatLoginImage(loginToken string) (string, []byte, bool, error) {
	payload, ok := wechatLoginStoreGet(wechatLoginStoreKey(wechatLoginImageKeyPrefix, loginToken))
	if !ok {
		return "", nil, false, nil
	}
	var img wechatLoginImage
	if err := common.UnmarshalJsonStr(payload, &img); err != nil {
		return "", nil, false, err
	}
	return img.ContentType, img.Data, true, nil
}
