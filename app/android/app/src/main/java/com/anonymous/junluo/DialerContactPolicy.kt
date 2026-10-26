package com.anonymous.junluo

/** Dial preparation rules. No permission requests, storage, or contact cache. */
object DialerContactPolicy {
    // Match the TypeScript wrapper's String.trim without folding non-English characters.
    const val TRIM_CHARACTERS = "\t\n\u000b\u000c\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff"
    data class ContactName(val contactId: String, val displayName: String)
    data class PhoneRow(val phoneRowId: String, val contactId: String, val number: String)
    data class Entry(val contactId: String, val phoneRowId: String, val displayName: String, val phoneNumber: String)
    data class Listing(val complete: Boolean, val reason: String? = null, val match: String? = null,
                       val entries: List<Entry> = emptyList(), val matchedContactCount: Int = 0)
    data class DialComponent(val packageName: String, val className: String, val enabled: Boolean = true,
                             val exported: Boolean = true, val accessible: Boolean = true)

    fun normalizePhoneNumber(input: String): String? {
        val text = input.trim { it in TRIM_CHARACTERS }
        if (text.isEmpty() || text.any { it !in '0'..'9' && it !in " () .-+" }) return null
        val number = text.filter { it in '0'..'9' || it == '+' }
        return number.takeIf { Regex("\\+?[0-9]{3,24}").matches(it) }
    }

    fun normalizeName(input: String): String = input.trim { it in TRIM_CHARACTERS }.map {
        if (it in 'A'..'Z') it + ('a' - 'A') else it
    }.joinToString("")

    fun literalSubstringPattern(name: String): String = "%" + name
        .replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"

    private fun validId(id: String): Boolean = id.toLongOrNull()?.let { it > 0 && it.toString() == id } == true

    fun validEntry(entry: Entry): Boolean = validId(entry.contactId) && validId(entry.phoneRowId) &&
        normalizeName(entry.displayName).isNotEmpty() && normalizePhoneNumber(entry.phoneNumber) == entry.phoneNumber

    fun query(input: String, findNames: (String, Boolean) -> List<ContactName>,
              findPhones: (String) -> List<PhoneRow>): Listing {
        val name = normalizeName(input)
        if (name.isEmpty()) return Listing(false, "INVALID_CONTACT_NAME")
        return try {
            fun matching(exact: Boolean): List<ContactName> {
                val values = findNames(name, exact)
                require(values.all { validId(it.contactId) && it.displayName.isNotBlank() })
                return values.filter {
                    val actual = normalizeName(it.displayName)
                    if (exact) actual == name else actual.contains(name)
                }.also { selected ->
                    require(selected.groupBy { it.contactId }.values.all { it.map { row -> row.displayName }.distinct().size == 1 })
                }.distinctBy { it.contactId }
            }
            val exact = matching(true)
            val names = if (exact.isNotEmpty()) exact else matching(false)
            if (names.isEmpty()) return Listing(true)
            val entries = names.flatMap { contact ->
                findPhones(contact.contactId).mapNotNull { row ->
                    require(validId(row.phoneRowId) && row.contactId == contact.contactId)
                    normalizePhoneNumber(row.number)?.let { Entry(contact.contactId, row.phoneRowId, contact.displayName, it) }
                }.distinctBy { it.phoneNumber }
            }
            Listing(true, if (entries.isEmpty()) "CONTACT_HAS_NO_NUMBER" else null,
                if (exact.isNotEmpty()) "exact" else "partial", entries, names.size)
        } catch (_: Exception) { Listing(false, "CONTACT_READ_FAILED") }
    }

    fun bindingMatches(binding: Entry, contact: ContactName?, row: PhoneRow?): Boolean =
        validEntry(binding) && contact?.contactId == binding.contactId && contact.displayName == binding.displayName &&
            row?.contactId == binding.contactId && row.phoneRowId == binding.phoneRowId &&
            normalizePhoneNumber(row.number) == binding.phoneNumber

    fun confirmDialComponent(defaultPackage: String?, resolved: DialComponent?, candidates: List<DialComponent>): DialComponent? {
        if (defaultPackage.isNullOrBlank() || resolved == null || resolved.packageName != defaultPackage ||
            resolved.className.isBlank() || !resolved.enabled || !resolved.exported || !resolved.accessible) return null
        return candidates.singleOrNull { it == resolved }
    }
}
