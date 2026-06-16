package controller

import (
	"strings"
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
)

// These cover the DB-backed branches of loginOrCreateUserByWeChatId (shared by the legacy
// code login and the scan-login status poll) using the in-memory test DB (WX-T-1).

func TestLoginOrCreateUserByWeChatIdExistingBound(t *testing.T) {
	db := newAffiliateRegistrationAttributionTestDB(t)
	if err := db.Create(&model.User{Id: 50, Username: "u50", WeChatId: "openid_bound", Status: common.UserStatusEnabled}).Error; err != nil {
		t.Fatalf("seed bound user: %v", err)
	}

	user, err := loginOrCreateUserByWeChatId("openid_bound", "")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if user == nil || user.Id != 50 {
		t.Fatalf("expected to load bound user 50, got %+v", user)
	}
}

func TestLoginOrCreateUserByWeChatIdNewUserOpenRegistration(t *testing.T) {
	newAffiliateRegistrationAttributionTestDB(t)
	common.RegisterEnabled = true

	user, err := loginOrCreateUserByWeChatId("openid_new", "")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if user == nil || user.Id == 0 || user.WeChatId != "openid_new" {
		t.Fatalf("expected a freshly provisioned bound user, got %+v", user)
	}
	if !strings.HasPrefix(user.Username, "wechat_") {
		t.Errorf("username = %q, want wechat_ prefix", user.Username)
	}
	if !model.IsWeChatIdAlreadyTaken("openid_new") {
		t.Error("new user was not persisted (wechat_id not taken)")
	}
}

func TestLoginOrCreateUserByWeChatIdRegistrationClosed(t *testing.T) {
	newAffiliateRegistrationAttributionTestDB(t)
	common.RegisterEnabled = false

	if _, err := loginOrCreateUserByWeChatId("openid_unbound", ""); err == nil {
		t.Fatal("expected an error when registration is closed and openid is unbound")
	}
}

func TestLoginOrCreateUserByWeChatIdDisabledUser(t *testing.T) {
	db := newAffiliateRegistrationAttributionTestDB(t)
	if err := db.Create(&model.User{Id: 51, Username: "u51", WeChatId: "openid_disabled", Status: common.UserStatusDisabled}).Error; err != nil {
		t.Fatalf("seed disabled user: %v", err)
	}

	if _, err := loginOrCreateUserByWeChatId("openid_disabled", ""); err == nil {
		t.Fatal("expected an error for a disabled user")
	}
}
