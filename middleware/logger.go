package middleware

import (
	"fmt"
	"regexp"

	"github.com/QuantumNous/new-api/common"
	"github.com/gin-gonic/gin"
)

const RouteTagKey = "route_tag"

func RouteTag(tag string) gin.HandlerFunc {
	return func(c *gin.Context) {
		c.Set(RouteTagKey, tag)
		c.Next()
	}
}

// sensitiveQueryRe matches bearer-like credentials carried in the query string so they can
// be redacted before reaching access logs. login_token is the WeChat scan-login session
// token (polled every ~2s); logging it verbatim would let anyone with log access replay the
// in-flight login.
var sensitiveQueryRe = regexp.MustCompile(`(login_token=)[^&]*`)

func redactSensitiveQuery(path string) string {
	return sensitiveQueryRe.ReplaceAllString(path, "${1}[redacted]")
}

func SetUpLogger(server *gin.Engine) {
	server.Use(gin.LoggerWithFormatter(func(param gin.LogFormatterParams) string {
		var requestID string
		if param.Keys != nil {
			requestID, _ = param.Keys[common.RequestIdKey].(string)
		}
		tag, _ := param.Keys[RouteTagKey].(string)
		if tag == "" {
			tag = "web"
		}
		return fmt.Sprintf("[GIN] %s | %s | %s | %3d | %13v | %15s | %7s %s\n",
			param.TimeStamp.Format("2006/01/02 - 15:04:05"),
			tag,
			requestID,
			param.StatusCode,
			param.Latency,
			param.ClientIP,
			param.Method,
			redactSensitiveQuery(param.Path),
		)
	}))
}
