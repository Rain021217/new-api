package service

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/QuantumNous/new-api/common"
)

func TestWeChatAuthorizationHeader(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want string
	}{
		{"empty", "", ""},
		{"whitespace only", "   ", ""},
		{"bare token", "abc123", "Bearer abc123"},
		{"already bearer", "Bearer abc123", "Bearer abc123"},
		{"lowercase bearer left as-is", "bearer abc123", "bearer abc123"},
		{"trimmed bare token", "  abc123  ", "Bearer abc123"},
	}
	for _, c := range cases {
		if got := wechatAuthorizationHeader(c.in); got != c.want {
			t.Errorf("%s: wechatAuthorizationHeader(%q) = %q, want %q", c.name, c.in, got, c.want)
		}
	}
}

// withMockWeChatServer points common.WeChatServerAddress at an httptest server for
// the duration of one test and restores the previous config afterwards.
func withMockWeChatServer(t *testing.T, handler http.HandlerFunc) (*httptest.Server, func()) {
	t.Helper()
	srv := httptest.NewServer(handler)
	prevAddr := common.WeChatServerAddress
	prevToken := common.WeChatServerToken
	common.WeChatServerAddress = srv.URL
	common.WeChatServerToken = "test-token"
	return srv, func() {
		common.WeChatServerAddress = prevAddr
		common.WeChatServerToken = prevToken
		srv.Close()
	}
}

func TestCreateWeChatLoginQRCodeSuccess(t *testing.T) {
	_, cleanup := withMockWeChatServer(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			t.Errorf("method = %s, want POST", r.Method)
		}
		if r.URL.Path != "/api/wechat/create_login_qrcode" {
			t.Errorf("path = %s", r.URL.Path)
		}
		if got := r.Header.Get("Authorization"); got != "Bearer test-token" {
			t.Errorf("Authorization = %q, want Bearer test-token", got)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"success":true,"message":"二维码创建成功","data":{"scene_id":"login_1","qrcode_url":"https://mp.weixin.qq.com/cgi-bin/showqrcode?ticket=t","login_token":"abc123","expire_seconds":600}}`))
	})
	defer cleanup()

	got, err := CreateWeChatLoginQRCode()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got.SceneID != "login_1" || got.LoginToken != "abc123" || got.ExpireSeconds != 600 || got.QRCodeURL == "" {
		t.Errorf("unexpected result: %+v", got)
	}
}

func TestCreateWeChatLoginQRCodeUpstreamFailureDesensitized(t *testing.T) {
	_, cleanup := withMockWeChatServer(t, func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"success":false,"message":"secret-boom","data":{"login_token":"leaky-token"}}`))
	})
	defer cleanup()

	_, err := CreateWeChatLoginQRCode()
	if err == nil {
		t.Fatal("expected error on upstream success:false")
	}
	if strings.Contains(err.Error(), "secret-boom") || strings.Contains(err.Error(), "leaky-token") {
		t.Errorf("error leaked upstream detail: %v", err)
	}
}

func TestCreateWeChatLoginQRCodeServerError(t *testing.T) {
	_, cleanup := withMockWeChatServer(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = w.Write([]byte(`not-json`))
	})
	defer cleanup()

	if _, err := CreateWeChatLoginQRCode(); err == nil {
		t.Fatal("expected error on 5xx/non-json body")
	}
}

func TestCreateWeChatLoginQRCodeMissingAddress(t *testing.T) {
	prev := common.WeChatServerAddress
	common.WeChatServerAddress = ""
	defer func() { common.WeChatServerAddress = prev }()

	if _, err := CreateWeChatLoginQRCode(); err == nil {
		t.Fatal("expected error when WeChatServerAddress is empty")
	}
}

func TestQueryWeChatLoginStatusSuccess(t *testing.T) {
	const token = "tok-success"
	_, cleanup := withMockWeChatServer(t, func(w http.ResponseWriter, r *http.Request) {
		if got := r.URL.Query().Get("login_token"); got != token {
			t.Errorf("login_token = %q, want %q", got, token)
		}
		_, _ = w.Write([]byte(`{"success":true,"message":"查询成功","data":{"status":"success","wechat_user":{"openid":"ojh_openid"},"auth_code":"secret-auth"}}`))
	})
	defer cleanup()

	got, err := QueryWeChatLoginStatus(token)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got.Status != WeChatLoginStatusSuccess {
		t.Errorf("status = %q, want success", got.Status)
	}
	if got.OpenID != "ojh_openid" {
		t.Errorf("openid = %q, want ojh_openid", got.OpenID)
	}
}

func TestQueryWeChatLoginStatusPending(t *testing.T) {
	_, cleanup := withMockWeChatServer(t, func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"success":true,"data":{"status":"pending"}}`))
	})
	defer cleanup()

	got, err := QueryWeChatLoginStatus("tok")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got.Status != WeChatLoginStatusPending {
		t.Errorf("status = %q, want pending", got.Status)
	}
	if got.OpenID != "" {
		t.Errorf("openid should be empty while pending, got %q", got.OpenID)
	}
}

func TestQueryWeChatLoginStatusExpired(t *testing.T) {
	_, cleanup := withMockWeChatServer(t, func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"success":false,"data":{"status":""},"message":"登录令牌无效或已过期"}`))
	})
	defer cleanup()

	got, err := QueryWeChatLoginStatus("tok")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got.Status != WeChatLoginStatusExpired {
		t.Errorf("status = %q, want expired", got.Status)
	}
}

func TestQueryWeChatLoginStatusEmptyToken(t *testing.T) {
	if _, err := QueryWeChatLoginStatus("   "); err == nil {
		t.Fatal("expected error for empty login token")
	}
}
