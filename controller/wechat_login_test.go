package controller

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/service"

	"github.com/gin-gonic/gin"
)

func init() { gin.SetMode(gin.TestMode) }

// setupWeChatLoginTest stands up a mock external WeChat program (create + image + status),
// points the config at it, and pins the session store to its in-memory branch. It returns a
// cleanup that restores every touched global.
func setupWeChatLoginTest(t *testing.T, statusBody string) func() {
	t.Helper()
	if statusBody == "" {
		statusBody = `{"success":true,"data":{"status":"pending"}}`
	}
	const imagePath = "/qrimage.png"
	var baseURL string

	mux := http.NewServeMux()
	mux.HandleFunc("/api/wechat/create_login_qrcode", func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"success":true,"message":"ok","data":{"scene_id":"login_x","qrcode_url":"` + baseURL + imagePath + `","login_token":"tok-create","expire_seconds":600}}`))
	})
	mux.HandleFunc(imagePath, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "image/png")
		_, _ = w.Write([]byte{0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a})
	})
	mux.HandleFunc("/api/wechat/login_status", func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(statusBody))
	})
	srv := httptest.NewServer(mux)
	baseURL = srv.URL

	prevEnabled := common.WeChatAuthEnabled
	prevAddr := common.WeChatServerAddress
	prevToken := common.WeChatServerToken
	prevRedis := common.RedisEnabled
	prevCode := common.WeChatCodeLoginEnabled
	prevScan := common.WeChatScanLoginEnabled
	prevQRInterval := common.WeChatScanLoginCreateIntervalSecondsPerIP
	common.WeChatAuthEnabled = true
	common.WeChatServerAddress = srv.URL
	common.WeChatServerToken = "test-token"
	common.RedisEnabled = false
	common.WeChatCodeLoginEnabled = true
	common.WeChatScanLoginEnabled = true
	// Disable the per-IP QR-create throttle for tests that don't exercise it; cases that do
	// will re-enable it locally. Without this every test after the first QR-create would be
	// rejected because httptest reuses the same client IP.
	common.WeChatScanLoginCreateIntervalSecondsPerIP = 0
	lastWeChatQRCreatePerIP.reset()

	return func() {
		common.WeChatAuthEnabled = prevEnabled
		common.WeChatServerAddress = prevAddr
		common.WeChatServerToken = prevToken
		common.RedisEnabled = prevRedis
		common.WeChatCodeLoginEnabled = prevCode
		common.WeChatScanLoginEnabled = prevScan
		common.WeChatScanLoginCreateIntervalSecondsPerIP = prevQRInterval
		lastWeChatQRCreatePerIP.reset()
		srv.Close()
	}
}

func newWeChatTestContext(method, target, body string) (*gin.Context, *httptest.ResponseRecorder) {
	w := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(w)
	if body != "" {
		c.Request = httptest.NewRequest(method, target, strings.NewReader(body))
	} else {
		c.Request = httptest.NewRequest(method, target, nil)
	}
	return c, w
}

func assertWeChatStatusField(t *testing.T, w *httptest.ResponseRecorder, want string) {
	t.Helper()
	if w.Code != http.StatusOK {
		t.Fatalf("status code = %d", w.Code)
	}
	if cc := w.Header().Get("Cache-Control"); cc != "no-store" {
		t.Errorf("Cache-Control = %q, want no-store", cc)
	}
	var resp struct {
		Success bool `json:"success"`
		Data    struct {
			Status string `json:"status"`
		} `json:"data"`
	}
	if err := common.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("unmarshal: %v (%s)", err, w.Body.String())
	}
	if resp.Data.Status != want {
		t.Errorf("status = %q, want %q (body=%s)", resp.Data.Status, want, w.Body.String())
	}
}

func TestWeChatLoginQRCodeCreate(t *testing.T) {
	defer setupWeChatLoginTest(t, "")()

	c, w := newWeChatTestContext(http.MethodPost, "/api/oauth/wechat/login/qrcode", `{"aff_code":"AFF7"}`)
	WeChatLoginQRCode(c)

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d", w.Code)
	}
	if cc := w.Header().Get("Cache-Control"); cc != "no-store" {
		t.Errorf("Cache-Control = %q, want no-store", cc)
	}
	if strings.Contains(w.Body.String(), "qrcode_url") || strings.Contains(w.Body.String(), "qrimage.png") {
		t.Errorf("response leaked external qrcode_url: %s", w.Body.String())
	}

	var resp struct {
		Success bool `json:"success"`
		Data    struct {
			LoginToken     string `json:"login_token"`
			QRCodeImageURL string `json:"qrcode_image_url"`
			ExpireSeconds  int    `json:"expire_seconds"`
		} `json:"data"`
	}
	if err := common.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if !resp.Success {
		t.Fatalf("success=false: %s", w.Body.String())
	}
	if resp.Data.LoginToken != "tok-create" {
		t.Errorf("login_token = %q", resp.Data.LoginToken)
	}
	if !strings.HasPrefix(resp.Data.QRCodeImageURL, "/api/oauth/wechat/login/qrcode/image") {
		t.Errorf("qrcode_image_url = %q", resp.Data.QRCodeImageURL)
	}
	if resp.Data.ExpireSeconds != wechatLoginMaxExpireSeconds() {
		t.Errorf("expire_seconds = %d, want %d (capped)", resp.Data.ExpireSeconds, wechatLoginMaxExpireSeconds())
	}

	sess, ok, _ := service.GetWeChatLoginSession("tok-create")
	if !ok {
		t.Fatal("session not stored")
	}
	if sess.InviteCode != "AFF7" {
		t.Errorf("invite code = %q, want AFF7", sess.InviteCode)
	}
	if _, _, ok, _ := service.GetWeChatLoginImage("tok-create"); !ok {
		t.Error("QR image not cached")
	}
}

func TestWeChatLoginStatusPending(t *testing.T) {
	defer setupWeChatLoginTest(t, `{"success":true,"data":{"status":"pending"}}`)()
	_ = service.SaveWeChatLoginSession("tok-pending", &service.WeChatLoginSession{
		Status:    service.WeChatLoginStatusPending,
		ExpiresAt: time.Now().Add(2 * time.Minute).Unix(),
	}, 2*time.Minute)

	c, w := newWeChatTestContext(http.MethodGet, "/api/oauth/wechat/login/status?login_token=tok-pending", "")
	WeChatLoginStatus(c)
	assertWeChatStatusField(t, w, "pending")
}

func TestWeChatLoginStatusExpiredWhenSessionMissing(t *testing.T) {
	defer setupWeChatLoginTest(t, "")()
	c, w := newWeChatTestContext(http.MethodGet, "/api/oauth/wechat/login/status?login_token=never", "")
	WeChatLoginStatus(c)
	assertWeChatStatusField(t, w, "expired")
}

func TestWeChatLoginStatusExpiredFromUpstream(t *testing.T) {
	defer setupWeChatLoginTest(t, `{"success":false,"data":{"status":""},"message":"登录令牌无效或已过期"}`)()
	_ = service.SaveWeChatLoginSession("tok-up-exp", &service.WeChatLoginSession{
		Status:    service.WeChatLoginStatusPending,
		ExpiresAt: time.Now().Add(2 * time.Minute).Unix(),
	}, 2*time.Minute)

	c, w := newWeChatTestContext(http.MethodGet, "/api/oauth/wechat/login/status?login_token=tok-up-exp", "")
	WeChatLoginStatus(c)
	assertWeChatStatusField(t, w, "expired")
}

func TestWeChatLoginQRCodeImageServesCached(t *testing.T) {
	defer setupWeChatLoginTest(t, "")()
	const token = "tok-img"
	_ = service.SaveWeChatLoginSession(token, &service.WeChatLoginSession{
		Status:    service.WeChatLoginStatusPending,
		ExpiresAt: time.Now().Add(time.Minute).Unix(),
	}, time.Minute)
	_ = service.SaveWeChatLoginImage(token, "image/png", []byte{0x89, 0x50, 0x4e, 0x47}, time.Minute)

	c, w := newWeChatTestContext(http.MethodGet, "/api/oauth/wechat/login/qrcode/image?login_token="+token, "")
	WeChatLoginQRCodeImage(c)

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d", w.Code)
	}
	if ct := w.Header().Get("Content-Type"); ct != "image/png" {
		t.Errorf("content type = %q, want image/png", ct)
	}
	if !strings.Contains(w.Header().Get("Cache-Control"), "no-store") {
		t.Errorf("cache-control = %q", w.Header().Get("Cache-Control"))
	}
	if w.Body.Len() == 0 {
		t.Error("empty image body")
	}
}

func TestWeChatLoginQRCodeImageNotFoundForUnknownToken(t *testing.T) {
	defer setupWeChatLoginTest(t, "")()
	c, w := newWeChatTestContext(http.MethodGet, "/api/oauth/wechat/login/qrcode/image?login_token=unknown", "")
	WeChatLoginQRCodeImage(c)
	if w.Code != http.StatusNotFound {
		t.Errorf("status = %d, want 404", w.Code)
	}
}

func TestWeChatLoginQRCodeModuleDisabled(t *testing.T) {
	defer setupWeChatLoginTest(t, "")()
	common.WeChatAuthEnabled = false

	c, w := newWeChatTestContext(http.MethodPost, "/api/oauth/wechat/login/qrcode", "")
	WeChatLoginQRCode(c)

	var resp struct {
		Success bool `json:"success"`
	}
	if err := common.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if resp.Success {
		t.Error("expected success=false when WeChat module is disabled")
	}
}

// TestWeChatScanLoginDisabledReturnsBusinessFailure asserts that, with the WeChat master switch
// still on, flipping just WeChatScanLoginEnabled off causes the scan-create endpoint to refuse
// with a success=false business response (not a panic and not 500).
func TestWeChatScanLoginDisabledReturnsBusinessFailure(t *testing.T) {
	defer setupWeChatLoginTest(t, "")()
	common.WeChatScanLoginEnabled = false

	c, w := newWeChatTestContext(http.MethodPost, "/api/oauth/wechat/login/qrcode", "")
	WeChatLoginQRCode(c)

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (business failure, not HTTP error)", w.Code)
	}
	var resp struct {
		Success bool   `json:"success"`
		Message string `json:"message"`
	}
	if err := common.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if resp.Success {
		t.Errorf("expected success=false when scan login is disabled, got body %s", w.Body.String())
	}
	if resp.Message == "" {
		t.Error("expected non-empty message explaining the refusal")
	}
}

// TestWeChatCodeLoginDisabledDoesNotAffectScanCreate proves the two flags are independent:
// turning off the legacy code-login flow must leave the scan-login QR create endpoint working.
func TestWeChatCodeLoginDisabledDoesNotAffectScanCreate(t *testing.T) {
	defer setupWeChatLoginTest(t, "")()
	common.WeChatCodeLoginEnabled = false
	common.WeChatScanLoginEnabled = true

	c, w := newWeChatTestContext(http.MethodPost, "/api/oauth/wechat/login/qrcode", `{"aff_code":"AFF8"}`)
	WeChatLoginQRCode(c)

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d", w.Code)
	}
	var resp struct {
		Success bool `json:"success"`
		Data    struct {
			LoginToken string `json:"login_token"`
		} `json:"data"`
	}
	if err := common.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if !resp.Success {
		t.Fatalf("expected success=true when only code-login is disabled, got %s", w.Body.String())
	}
	if resp.Data.LoginToken == "" {
		t.Error("expected a login_token to be returned")
	}
}

// TestWeChatLoginQRCodePerIPRateLimitRejectsImmediateReuse fires two QR-create calls back-to-back
// from the same IP with a 1s window and asserts the second is refused with a business failure.
func TestWeChatLoginQRCodePerIPRateLimitRejectsImmediateReuse(t *testing.T) {
	defer setupWeChatLoginTest(t, "")()
	common.WeChatScanLoginCreateIntervalSecondsPerIP = 1
	lastWeChatQRCreatePerIP.reset()

	c1, w1 := newWeChatTestContext(http.MethodPost, "/api/oauth/wechat/login/qrcode", "")
	WeChatLoginQRCode(c1)
	var first struct {
		Success bool `json:"success"`
	}
	if err := common.Unmarshal(w1.Body.Bytes(), &first); err != nil {
		t.Fatalf("first unmarshal: %v", err)
	}
	if !first.Success {
		t.Fatalf("first call should succeed, body=%s", w1.Body.String())
	}

	c2, w2 := newWeChatTestContext(http.MethodPost, "/api/oauth/wechat/login/qrcode", "")
	WeChatLoginQRCode(c2)
	if w2.Code != http.StatusOK {
		t.Fatalf("second call HTTP status = %d, want 200", w2.Code)
	}
	var second struct {
		Success bool   `json:"success"`
		Message string `json:"message"`
	}
	if err := common.Unmarshal(w2.Body.Bytes(), &second); err != nil {
		t.Fatalf("second unmarshal: %v", err)
	}
	if second.Success {
		t.Errorf("expected second call to be rate-limited, got success=true body=%s", w2.Body.String())
	}
	if second.Message == "" {
		t.Error("expected a non-empty rate-limit message")
	}
}

// TestWeChatLoginQRCodePerIPRateLimitAllowsAfterInterval asserts the per-IP throttle releases
// after the configured interval elapses, so an honest user who pauses can retry.
func TestWeChatLoginQRCodePerIPRateLimitAllowsAfterInterval(t *testing.T) {
	defer setupWeChatLoginTest(t, "")()
	common.WeChatScanLoginCreateIntervalSecondsPerIP = 1
	lastWeChatQRCreatePerIP.reset()

	c1, w1 := newWeChatTestContext(http.MethodPost, "/api/oauth/wechat/login/qrcode", "")
	WeChatLoginQRCode(c1)
	var first struct {
		Success bool `json:"success"`
	}
	if err := common.Unmarshal(w1.Body.Bytes(), &first); err != nil {
		t.Fatalf("first unmarshal: %v", err)
	}
	if !first.Success {
		t.Fatalf("first call should succeed, body=%s", w1.Body.String())
	}

	// Wait just past the configured interval so the second call is allowed again.
	time.Sleep(1100 * time.Millisecond)

	c2, w2 := newWeChatTestContext(http.MethodPost, "/api/oauth/wechat/login/qrcode", "")
	WeChatLoginQRCode(c2)
	var second struct {
		Success bool   `json:"success"`
		Message string `json:"message"`
	}
	if err := common.Unmarshal(w2.Body.Bytes(), &second); err != nil {
		t.Fatalf("second unmarshal: %v", err)
	}
	if !second.Success {
		t.Errorf("expected second call to succeed after interval elapses, body=%s", w2.Body.String())
	}
}
