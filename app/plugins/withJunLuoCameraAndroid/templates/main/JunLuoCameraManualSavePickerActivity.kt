package __PACKAGE_NAME__.camera

import android.app.Activity
import android.content.Intent
import android.os.Bundle

internal class JunLuoCameraManualSavePickerActivity : Activity() {
    companion object {
        private const val DIRECTORY_REQUEST_CODE = 8716

        fun open(activity: Activity): Result<Unit> = runCatching {
            activity.startActivity(Intent(activity, JunLuoCameraManualSavePickerActivity::class.java))
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (savedInstanceState == null) {
            val intent = Intent(Intent.ACTION_OPEN_DOCUMENT_TREE).apply {
                addFlags(
                    Intent.FLAG_GRANT_READ_URI_PERMISSION or
                        Intent.FLAG_GRANT_WRITE_URI_PERMISSION or
                        Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION or
                        Intent.FLAG_GRANT_PREFIX_URI_PERMISSION,
                )
            }
            startActivityForResult(intent, DIRECTORY_REQUEST_CODE)
        }
    }

    @Deprecated("Android activity result compatibility path")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        if (requestCode != DIRECTORY_REQUEST_CODE) {
            super.onActivityResult(requestCode, resultCode, data)
            return
        }
        val treeUri = data?.data
        if (resultCode == RESULT_OK && treeUri != null) {
            val permissionFlags = data.flags and (
                Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION
            )
            runCatching {
                contentResolver.takePersistableUriPermission(treeUri, permissionFlags)
                JunLuoCameraManualSaveStore.set(this, treeUri.toString(), System.currentTimeMillis()).getOrThrow()
            }
        }
        finish()
    }
}
