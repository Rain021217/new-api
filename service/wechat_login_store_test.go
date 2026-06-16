package service

import (
	"bytes"
	"strings"
	"testing"
	"time"

	"github.com/QuantumNous/new-api/common"
)

// forceWeChatLoginMemoryStore pins the store to its in-memory branch for the test, since
// the unit-test binary has no live Redis client (RDB is nil while RedisEnabled defaults true).
func forceWeChatLoginMemoryStore(t *testing.T) {
	t.Helper()
	prev := common.RedisEnabled
	common.RedisEnabled = false
	t.Cleanup(func() { common.RedisEnabled = prev })
}

func TestWeChatLoginStoreKeyHashesToken(t *testing.T) {
	const token = "plain-login-token-123"
	key := wechatLoginStoreKey(wechatLoginSessionKeyPrefix, token)
	if !strings.HasPrefix(key, wechatLoginSessionKeyPrefix) {
		t.Errorf("key missing prefix: %q", key)
	}
	if strings.Contains(key, token) {
		t.Errorf("key leaks plaintext token: %q", key)
	}
	if got := len(strings.TrimPrefix(key, wechatLoginSessionKeyPrefix)); got != 64 {
		t.Errorf("hash length = %d, want 64 (sha256 hex)", got)
	}
	if wechatLoginStoreKey(wechatLoginSessionKeyPrefix, token) != key {
		t.Error("key not deterministic for the same token")
	}
	if wechatLoginStoreKey(wechatLoginSessionKeyPrefix, token+"x") == key {
		t.Error("different tokens produced the same key")
	}
	if wechatLoginStoreKey(wechatLoginImageKeyPrefix, token) == key {
		t.Error("image and session namespaces collided for the same token")
	}
}

func TestWeChatLoginSessionRoundTrip(t *testing.T) {
	forceWeChatLoginMemoryStore(t)
	const token = "tok-roundtrip"
	in := &WeChatLoginSession{
		SceneID:    "login_42",
		Status:     WeChatLoginStatusPending,
		InviteCode: "AFF7",
		ExpiresAt:  time.Now().Add(3 * time.Minute).Unix(),
	}
	if err := SaveWeChatLoginSession(token, in, time.Minute); err != nil {
		t.Fatalf("save: %v", err)
	}
	got, ok, err := GetWeChatLoginSession(token)
	if err != nil || !ok {
		t.Fatalf("get: ok=%v err=%v", ok, err)
	}
	if got.SceneID != in.SceneID || got.Status != in.Status || got.InviteCode != in.InviteCode || got.ExpiresAt != in.ExpiresAt {
		t.Errorf("roundtrip mismatch: %+v vs %+v", got, in)
	}
	if err := DeleteWeChatLoginSession(token); err != nil {
		t.Fatalf("delete: %v", err)
	}
	if _, ok, _ := GetWeChatLoginSession(token); ok {
		t.Error("session still present after delete")
	}
}

func TestWeChatLoginSessionExpires(t *testing.T) {
	forceWeChatLoginMemoryStore(t)
	const token = "tok-expire"
	if err := SaveWeChatLoginSession(token, &WeChatLoginSession{Status: WeChatLoginStatusPending}, 30*time.Millisecond); err != nil {
		t.Fatalf("save: %v", err)
	}
	time.Sleep(60 * time.Millisecond)
	if _, ok, _ := GetWeChatLoginSession(token); ok {
		t.Error("expected session to expire after its TTL")
	}
}

func TestWeChatLoginSessionMissing(t *testing.T) {
	forceWeChatLoginMemoryStore(t)
	got, ok, err := GetWeChatLoginSession("never-saved")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if ok || got != nil {
		t.Errorf("expected not found, got ok=%v session=%+v", ok, got)
	}
}

func TestWeChatLoginImageRoundTrip(t *testing.T) {
	forceWeChatLoginMemoryStore(t)
	const token = "tok-image"
	data := []byte{0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a} // PNG magic header
	if err := SaveWeChatLoginImage(token, "image/png", data, time.Minute); err != nil {
		t.Fatalf("save image: %v", err)
	}
	ct, got, ok, err := GetWeChatLoginImage(token)
	if err != nil || !ok {
		t.Fatalf("get image: ok=%v err=%v", ok, err)
	}
	if ct != "image/png" {
		t.Errorf("content type = %q, want image/png", ct)
	}
	if !bytes.Equal(got, data) {
		t.Errorf("image bytes mismatch: %v vs %v", got, data)
	}
}
